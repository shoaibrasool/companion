from langgraph.graph import StateGraph, START, END

from state import CompanionState
from llm_node import llm_node
from persist_data import persist_data_node

builder = StateGraph(CompanionState)
builder.add_node(llm_node)
builder.add_node(persist_data_node)
builder.add_edge(START, "llm_node")
builder.add_edge("llm_node", "persist_data_node")
builder.add_edge("persist_data_node", END)

graph = builder.compile()
