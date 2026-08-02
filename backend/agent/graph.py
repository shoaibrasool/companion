from langgraph.graph import END, START, StateGraph

from backend.agent.state import CompanionState
from backend.agent.llm_node import llm_node
from backend.agent.persist_node import persist_data_node

builder = StateGraph(CompanionState)
builder.add_node(llm_node)
builder.add_node(persist_data_node)
builder.add_edge(START, "llm_node")
builder.add_edge("llm_node", "persist_data_node")
builder.add_edge("persist_data_node", END)

graph = builder.compile()
