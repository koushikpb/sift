"""LoRA fine-tune an encoder for CUAD clause-type classification. Controller-run (heavy).
Heavy deps (torch/transformers/peft/datasets) are imported at call time."""
from __future__ import annotations

import os
from pathlib import Path

from pipeline.classify.metrics import compute_clf_metrics
from pipeline.classify.models import load_examples, load_label_map

_REPO_ROOT = Path(__file__).parents[3]
CLF_DATA_DIR = _REPO_ROOT / "data" / "processed" / "cuad_clf"
MODEL_DIR = _REPO_ROOT / "models" / "cuad_clf"
BASE_MODEL = os.environ.get("CLF_BASE_MODEL", "microsoft/deberta-v3-base")
MAX_LEN = int(os.environ.get("CLF_MAX_LEN", "128"))
SEED = 42


def run_train(data_dir: Path = CLF_DATA_DIR, out_dir: Path = MODEL_DIR) -> None:
    import torch
    from datasets import Dataset  # noqa: E402
    from peft import LoraConfig, TaskType, get_peft_model
    from transformers import (
        AutoModelForSequenceClassification,
        AutoTokenizer,
        DataCollatorWithPadding,
        Trainer,
        TrainingArguments,
    )

    labels = load_label_map(data_dir / "label_map.json")
    label2id = {lbl: i for i, lbl in enumerate(labels)}
    id2label = dict(enumerate(labels))

    def to_ds(split: str) -> Dataset:
        ex = load_examples(data_dir / f"{split}.jsonl")
        return Dataset.from_list([{"text": e.text, "label": label2id[e.clause_type]} for e in ex])

    tok = AutoTokenizer.from_pretrained(BASE_MODEL)
    train_ds, val_ds = to_ds("train"), to_ds("val")

    # Pad every example to a fixed MAX_LEN so all batches share one [B, MAX_LEN] shape.
    # With per-batch dynamic padding, each new sequence length is a new tensor shape and MPS
    # recompiles the graph almost every step (~15-30s stalls -> ~21h). A fixed shape compiles
    # once -> ~0.5s/step. Clauses are short (median 39 tok, 91.5% <= 128), so 128 truncates few.
    def tok_fn(batch):
        return tok(batch["text"], truncation=True, padding="max_length", max_length=MAX_LEN)

    train_ds = train_ds.map(tok_fn, batched=True)
    val_ds = val_ds.map(tok_fn, batched=True)

    model = AutoModelForSequenceClassification.from_pretrained(
        BASE_MODEL, num_labels=len(labels), id2label=id2label, label2id=label2id,
    )
    # DeBERTa attention proj names; for roberta/bert use ["query","value"].
    target = os.environ.get("CLF_LORA_TARGETS", "query_proj,value_proj").split(",")
    # deberta-v3 is an MLM checkpoint: its SEQ_CLS pooler.dense + classifier are
    # randomly initialized (absent from the base weights). Both MUST be trained and
    # saved with the adapter, else eval re-inits a *different* random pooler and the
    # LoRA model scores near-random — silently invalidating the before/after gate.
    # (roberta/bert have no separate `pooler` in the head; override via CLF_SAVE_MODULES.)
    save_modules = os.environ.get("CLF_SAVE_MODULES", "classifier,pooler").split(",")
    peft_model = get_peft_model(
        model,
        LoraConfig(task_type=TaskType.SEQ_CLS, r=16, lora_alpha=32, lora_dropout=0.1,
                   target_modules=target, modules_to_save=save_modules),
    )
    peft_model.print_trainable_parameters()

    args = TrainingArguments(
        output_dir=str(out_dir / "_checkpoints"),
        learning_rate=2e-4, per_device_train_batch_size=16, per_device_eval_batch_size=32,
        num_train_epochs=10, weight_decay=0.01, eval_strategy="epoch", save_strategy="epoch",
        load_best_model_at_end=True, metric_for_best_model="macro_f1", greater_is_better=True,
        seed=SEED, report_to="none", logging_steps=20,
    )
    trainer = Trainer(
        model=peft_model, args=args, train_dataset=train_ds, eval_dataset=val_ds,
        data_collator=DataCollatorWithPadding(tok),
        compute_metrics=lambda ep: compute_clf_metrics(
            ep.predictions.tolist(), ep.label_ids.tolist(), labels),
    )
    torch.manual_seed(SEED)
    trainer.train()
    out_dir.mkdir(parents=True, exist_ok=True)
    peft_model.save_pretrained(str(out_dir))
    tok.save_pretrained(str(out_dir))
    print(f"clf-train: adapter saved -> {out_dir}")


if __name__ == "__main__":
    run_train()
