"""Fixed-point units and the one-time migration of existing credit balances."""

import json


POINT_SCALE = 1_000_000
MODEL_PRICE_MAX = 1_000_000 * POINT_SCALE
CREDIT_ADJUSTMENT_MAX = 10_000 * POINT_SCALE


def migrate(db):
    db.execute("CREATE TABLE IF NOT EXISTS billing_precision (scale INTEGER PRIMARY KEY)")
    if not db.execute("INSERT OR IGNORE INTO billing_precision(scale) VALUES(?)", (POINT_SCALE,)).rowcount:
        return
    factor = POINT_SCALE // 100
    amounts = {
        "users": ("points",),
        "ledger": ("amount",),
        "credit_codes": ("amount",),
        "generation_jobs": ("price",),
        "cpa_models": ("price", "input_rate", "output_rate"),
        "chat_turns": ("price",),
        "chat_billing": ("remainder",),
    }
    for table, columns in amounts.items():
        assignments = ", ".join(f"{column}={column}*?" for column in columns)
        db.execute(f"UPDATE {table} SET {assignments}", (factor,) * len(columns))
    for turn in db.execute("SELECT id,token_rates FROM chat_turns WHERE token_rates IS NOT NULL"):
        rates = {key: value * factor for key, value in json.loads(turn["token_rates"]).items()}
        db.execute("UPDATE chat_turns SET token_rates=? WHERE id=?", (json.dumps(rates), turn["id"]))
    for plan in db.execute("SELECT id,actions FROM chat_image_plans"):
        actions = json.loads(plan["actions"])
        for action in actions:
            action["unitPrice"] *= factor
            action["total"] *= factor
        db.execute("UPDATE chat_image_plans SET actions=? WHERE id=?", (json.dumps(actions, ensure_ascii=False), plan["id"]))
