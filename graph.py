from langgraph.graph import StateGraph, START, END
from state import CompanionState
from llm_node import llm_node
from input_node import input_node
from persist_data import persist_data_node
from condition import should_continue
import models
from database import init_db
import os
from load_chat_history import load_chat_history

if not os.path.exists("sql_app.db"):
    print("creating sql_lite db file")
    init_db()

graph = StateGraph(CompanionState)
graph.add_node(input_node)
graph.add_node(llm_node)
graph.add_node(persist_data_node)
graph.add_edge(START, "input_node")
graph.add_conditional_edges("input_node", should_continue , ["llm_node", END])
graph.add_edge("llm_node", "persist_data_node")
graph.add_edge("persist_data_node", "input_node")

graph = graph.compile()

chat_history = load_chat_history() 

print(f"chat history {chat_history}")

graph.invoke({
    "quit": False,
    "messages": chat_history[-30:]
})
