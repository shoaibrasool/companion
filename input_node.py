from state import CompanionState
from langchain_core.messages import HumanMessage

def input_node(state:CompanionState):
    
    for msg in state["messages"]:
        msg_type = getattr(msg, "type", None)
        content = getattr(msg, "content", "")

        if msg_type == "human":
            print(f"Me: {content}")
        elif msg_type == "ai":
            print(f"Companion: {content}")
    
    user_text = input("Enter text or \"q\" to quit: ").strip()
    if (user_text=="q"):
        return { "quit" : True}
    
    return {
        "messages": [HumanMessage(content=user_text)]        
        } 
