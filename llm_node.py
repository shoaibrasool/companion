from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI
from state import CompanionState
from langchain_core.messages import AIMessage, SystemMessage
from system_prompt import SystemPrompt

load_dotenv()

llm = ChatGoogleGenerativeAI(model = "gemini-3.1-flash-lite")

def llm_node(state: CompanionState):
    messages = [SystemMessage(content=SystemPrompt)] + state["messages"]
    
    full_response = ""
    for chunk in llm.stream(messages):
        content = chunk.content
        for block in content:
            text = block.get("text", "")
            print((text), end="", flush=True)
            full_response += text
    print()    
    return {"messages" : [AIMessage(content = full_response)]}