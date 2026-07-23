from state import CompanionState

def input_node(state:CompanionState):
    user_text = input("Enter text or \"q\" to quit: ").strip()
    if (user_text=="q"):
        return { "quit" : True}
    
    return {"input": user_text}
