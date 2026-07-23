from typing import TypedDict, Annotated
from langgraph.graph.message import add_messages


class CompanionState(TypedDict):
    quit : bool
    messages : Annotated[list, add_messages]