from sqlalchemy import Column, Integer, String, DateTime
from database import Base
from datetime import datetime

class Message(Base):
    __tablename__ = "messages"
    id = Column(Integer, primary_key=True)
    role=Column(String)
    content=Column(String)
    created_at=Column(DateTime, default=datetime.now)