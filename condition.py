from state import CompanionState
from langgraph.graph import END


def should_continue(state:CompanionState):
    if (state.get("quit", False)):
        return END
    
    return "mock_llm_node"