from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI
from state import CompanionState
from langchain_core.messages import AIMessage, SystemMessage
from system_prompt import SystemPrompt
from langgraph.types import StreamWriter

load_dotenv()

llm = ChatGoogleGenerativeAI(model="gemini-3.1-flash-lite")

async def llm_node(state: CompanionState, writer: StreamWriter):
    messages = [SystemMessage(content=SystemPrompt)] + state["messages"]

    full_response = ""
    async for chunk in llm.astream(messages):
        content = chunk.content
        if isinstance(content, list):
            text = "".join(b.get("text", "") for b in content)
        else:
            text = content or ""
        if text:
            writer({"type": "token", "content": text})
            full_response += text

    return {"messages": [AIMessage(content=full_response)]}