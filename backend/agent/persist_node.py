from backend.core.db import Message, SessionLocal
from backend.agent.state import CompanionState


def persist_data_node(state: CompanionState):
    new_messages = state["messages"][-2:]

    db = SessionLocal()
    try:
        for msg in new_messages:
            msg_type = getattr(msg, "type", None)
            content = getattr(msg, "content", "")

            if msg_type == "human":
                role = "human"
            elif msg_type == "ai":
                role = "ai"
            else:
                role = "unknown"

            db.add(Message(role=role, content=content))

        db.commit()

    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    return {}
