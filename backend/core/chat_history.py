from backend.core.db import Message, SessionLocal
from langchain_core.messages import AIMessage, HumanMessage


def load_chat_history():
    db = SessionLocal()
    try:
        db_messages_inverse = db.query(Message).order_by(Message.created_at.desc(), Message.id.desc()).limit(30).all()
        db_messages = list(reversed(db_messages_inverse))
        history = []

        for msg in db_messages:
            if msg.role == "human":
                history.append(HumanMessage(content=msg.content))
            elif msg.role == "ai":
                history.append(AIMessage(content=msg.content))

        return history

    finally:
        db.close()
