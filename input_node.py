from state import CompanionState
from langchain_core.messages import HumanMessage

def input_node(state:CompanionState):
    
    user_text = input("Enter text or \"q\" to quit: ").strip()
    if (user_text=="q"):
        return { "quit" : True}
    
    return {
        "messages": [HumanMessage(content=user_text)]        
        } 
