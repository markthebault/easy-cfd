"""One heavy local job across browser tabs and the OpenFOAM queue."""

import threading
import time
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()
LOCK = threading.RLock()
OWNER = None
UNTIL = 0.0
SERVER_JOB = None


class Lease(BaseModel):
    owner: str = Field(min_length=1, max_length=100)


@router.post("/api/compute-lease")
def acquire(lease: Lease):
    global OWNER, UNTIL
    with LOCK:
        if SERVER_JOB or (OWNER and OWNER != lease.owner and time.monotonic() < UNTIL):
            raise HTTPException(
                409, "Another local simulation is running. Stop it or wait before starting this run."
            )
        OWNER = lease.owner
        UNTIL = time.monotonic() + 90
        return {"owner": OWNER, "expires_seconds": 90}


@router.delete("/api/compute-lease/{owner}")
def release(owner: str):
    global OWNER, UNTIL
    with LOCK:
        if OWNER == owner:
            OWNER = None
            UNTIL = 0.0
    return {"released": True}


def start_server(key):
    global SERVER_JOB
    with LOCK:
        if OWNER and time.monotonic() < UNTIL:
            return False
        SERVER_JOB = key
        return True


def finish_server():
    global SERVER_JOB
    with LOCK:
        SERVER_JOB = None
