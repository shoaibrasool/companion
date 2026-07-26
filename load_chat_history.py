from langchain_core.messages import AIMessage, HumanMessage
from database import SessionLocal
from models import Message

def load_chat_history():
    db = SessionLocal()
    try:
        db_messages = db.query(Message).order_by(Message.created_at.asc()).all()
        history = []
        
        for msg in db_messages:
            if msg.role == "human":
                history.append(HumanMessage(content=msg.content))
            elif msg.role == "ai":
                history.append(AIMessage(content=msg.content))
                
        return history
    
    finally:
        db.close()