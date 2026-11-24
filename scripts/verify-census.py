"""Recount a census CSV independently using only the Python standard library."""

import argparse
import base64
import csv
import gzip
import hashlib
import io
import json
import time
import urllib.request
from collections import Counter
from datetime import datetime, timezone


def utc(timestamp):
    return datetime.fromtimestamp(int(timestamp), timezone.utc).isoformat()


def event_round_id(row):
    """Read the OCR2 NewTransmission event from the public Devnet RPC."""
    query = {"jsonrpc": "2.0", "id": 1, "method": "getTransaction", "params": [
        row["signature"], {"commitment": "finalized", "encoding": "json", "maxSupportedTransactionVersion": 0}]}
    req = urllib.request.Request("https://api.devnet.solana.com", json.dumps(query).encode(),
                                 {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        tx = json.load(response)["result"]
    if (tx["meta"]["err"] is not None or tx["slot"] != int(row["slot"]) or
            tx["blockTime"] != int(row["blockTime"]) or tx["transaction"]["signatures"][0] != row["signature"]):
        raise ValueError(f"Boundary transaction mismatch at {row['signature']}")
    discriminator = hashlib.sha256(b"event:NewTransmission").digest()[:8]
    program = "cjg3oHmg9uuPsP8D6g29NWvhySJkdYdAo9D25PRbKXJ"
    stack, events = [], []
    for line in tx["meta"]["logMessages"]:
        if line.startswith("Program ") and " invoke [" in line:
            stack.append(line.split()[1])
        elif line.startswith("Program ") and line.endswith(" success"):
            stack.pop()
        elif stack and stack[-1] == program and line.startswith("Program data: "):
            data = base64.b64decode(line.split()[-1])
            if data.startswith(discriminator):
                events.append(int.from_bytes(data[8:12], "little"))
    if len(events) != 1:
        raise ValueError(f"Expected one NewTransmission event at {row['signature']}")
    return events[0]


def recount(path, check_boundaries):
    with gzip.open(path, "rb") as archive:
        data = archive.read()
    print("CSV SHA-256", hashlib.sha256(data).hexdigest())
    first, last, last_order = {}, {}, {}
    counts = Counter()
    adjacent = Counter()
    straddling = Counter()
    for row in csv.DictReader(io.StringIO(data.decode("ascii"))):
        feed = row["feed"]
        slot = int(row["slot"])
        order = (slot, int(row["transactionIndex"]), *map(int, row["instruction"].split(".")))
        if feed in last_order and order <= last_order[feed]:
            raise ValueError(f"Duplicate or out-of-order instruction at {row['signature']}")
        last_order[feed] = order
        epoch, rnd = int(row["epoch"]), int(row["round"])
        if not 1 <= rnd <= 6:
            raise ValueError(f"Round outside recorded config at {row['signature']}")
        if feed in last:
            prev = last[feed]
            # rMax=6 for every config digest pinned in the online decoder.
            distance = 6 * (epoch - int(prev["epoch"])) + rnd - int(prev["round"])
            if distance == 1:
                adjacent[feed] += 1
                if int(row["observationTime"]) > int(prev["observationTime"]):
                    straddling[feed] += 1
        first.setdefault(feed, row)
        last[feed] = row
        counts[feed] += 1

    print("Feed  First slot/UTC  Last slot/UTC  Landed  Nonadjacent  Adjacent  Increasing")
    for feed, count in counts.items():
        start, end = first[feed], last[feed]
        print(feed, start["slot"], utc(start["blockTime"]), end["slot"], utc(end["blockTime"]),
              count, count - 1 - adjacent[feed], adjacent[feed], straddling[feed])
    total, pairs = sum(counts.values()), sum(adjacent.values())
    print("Total", total, total - len(counts) - pairs, pairs, sum(straddling.values()))
    if check_boundaries:
        for feed, count in counts.items():
            lo = event_round_id(first[feed])
            time.sleep(1)
            hi = event_round_id(last[feed])
            if hi - lo + 1 != count:
                raise ValueError(f"{feed} on-chain counter span {lo}..{hi} differs from {count}")
            print(feed, "NewTransmission.round_id", lo, hi, "inclusive count", count)
            time.sleep(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", help="Path to the gzipped evidence CSV")
    parser.add_argument("--check-boundaries", action="store_true",
                        help="Also cross-check first/last on-chain counters via the public Devnet RPC")
    args = parser.parse_args()
    recount(args.archive, args.check_boundaries)
