from langchain_core.messages import AIMessage, HumanMessage
from database import SessionLocal
from models import Message
from sqlalchemy import select

def load_chat_history():
    db = SessionLocal()
    try:
        
        subquery = (
            select(Message)
            .order_by(Message.created_at.desc())
            .limit(30)
            .subquery()
        )
        
        db_messages = (
            db.query(Message)
            .filter(Message.id.in_(select(subquery.c.id)))
            .order_by(Message.created_at.asc())
            .all()
        )
        history = []
        
        for msg in db_messages:
            if msg.role == "human":
                history.append(HumanMessage(content=msg.content))
            elif msg.role == "ai":
                history.append(AIMessage(content=msg.content))
                
        return history
    
    finally:
        db.close()