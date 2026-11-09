"""Summarize diagnostic WebKit/V8 live snapshots; sizes are not process RSS."""
import collections
import json
from pathlib import Path
import sys


def classify(properties):
    messages = {"body", "destination", "messageId", "ackId", "createdAt"}
    controllers = {"config", "credentials", "messages", "pendingMessages", "peers"}
    return {
        "messageObjects": sum(messages.issubset(fields) for fields in properties.values()),
        "stompControllerStates": sum(controllers.issubset(fields) for fields in properties.values()),
    }


def webkit(snapshot):
    nodes, edges = snapshot["nodes"], snapshot["edges"]
    classes = snapshot["nodeClassNames"]
    properties = collections.defaultdict(set)
    totals = collections.defaultdict(lambda: [0, 0])
    for offset in range(0, len(nodes), 4):
        item = totals[classes[nodes[offset + 2]]]
        item[0] += 1
        item[1] += nodes[offset + 1]
    for offset in range(0, len(edges), 4):
        if snapshot["edgeTypes"][edges[offset + 2]] == "Property":
            properties[edges[offset]].add(snapshot["edgeNames"][edges[offset + 3]])
    return {"nodes": len(nodes) // 4, "estimatedBytes": sum(nodes[1::4]), **classify(properties),
            "largestClasses": sorted(totals.items(), key=lambda item: item[1][1], reverse=True)[:12]}


def chromium(snapshot):
    meta = snapshot["snapshot"]["meta"]
    node_fields, edge_fields = meta["node_fields"], meta["edge_fields"]
    ns, es = len(node_fields), len(edge_fields)
    nodes, edges, strings = snapshot["nodes"], snapshot["edges"], snapshot["strings"]
    properties = collections.defaultdict(set)
    totals = collections.defaultdict(lambda: [0, 0])
    edge_offset = 0
    for offset in range(0, len(nodes), ns):
        name = strings[nodes[offset + node_fields.index("name")]]
        item = totals[name]
        item[0] += 1
        item[1] += nodes[offset + node_fields.index("self_size")]
        count = nodes[offset + node_fields.index("edge_count")]
        for _ in range(count):
            kind = meta["edge_types"][edge_fields.index("type")][edges[edge_offset + edge_fields.index("type")]]
            if kind == "property":
                properties[offset].add(strings[edges[edge_offset + edge_fields.index("name_or_index")]])
            edge_offset += es
    return {"nodes": len(nodes) // ns, "estimatedBytes": sum(nodes[node_fields.index("self_size")::ns]), **classify(properties),
            "largestClasses": sorted(totals.items(), key=lambda item: item[1][1], reverse=True)[:12]}


folder = Path(sys.argv[1])
reports = []
for filename in sorted(folder.glob("*-tauri-js-heap.json")) + sorted(folder.glob("*-electron.heapsnapshot")):
    data = json.loads(filename.read_text())
    result = webkit(data) if "nodeClassNames" in data else chromium(data)
    reports.append({"file": filename.name, **result})
    print(filename.name, "estimatedMiB", round(result["estimatedBytes"] / 1048576, 2),
          "messages", result["messageObjects"], "controllerStates", result["stompControllerStates"])
(folder / "heap-analysis.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2) + "\n")
