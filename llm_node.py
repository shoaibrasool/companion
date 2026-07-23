from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI
from state import CompanionState

load_dotenv()

llm = ChatGoogleGenerativeAI(model = "gemini-3.1-flash-lite")

def mock_llm_node(state: CompanionState):
    for chunk in llm.stream(state["input"]):
        content = chunk.content
        for block in content:
            print(block.get("text", ""), end="", flush=True)
        
    print()    
    return {}