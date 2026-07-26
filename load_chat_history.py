from langchain_core.messages import AIMessage, HumanMessage
from database import SessionLocal
from models import Message
from sqlalchemy import select

def load_chat_history():
    db = SessionLocal()
    try:
        db_messages_inverse = db.query(Message).order_by(Message.created_at.desc()).limit(30).all()
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