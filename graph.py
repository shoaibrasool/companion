from langgraph.graph import StateGraph, START, END
from state import CompanionState
from llm_node import llm_node
from input_node import input_node
from condition import should_continue


graph = StateGraph(CompanionState)
graph.add_node(input_node)
graph.add_node(llm_node)
graph.add_edge(START, "input_node")
graph.add_conditional_edges("input_node", should_continue , ["llm_node", END])
graph.add_edge("llm_node", "input_node")

graph = graph.compile()

graph.invoke({"input" : ""})
