import { app } from "../../scripts/app.js";

// Depth-complete enumeration of every GlobalSet node in the document.
// Walks the live instance tree (node.subgraph) recursively, so setters nested
// inside subgraphs-within-subgraphs at ANY depth are found. This replaces the
// shallow root._subgraphs/subgraphs definitions-map walk used previously.
function findAllGlobalSetNodes(graph) {
    let setNodes = [];
    if (!graph || !graph._nodes) return setNodes;
    for (const node of graph._nodes) {
        if (node.type === "GlobalSet") setNodes.push(node);
        if (node.subgraph) setNodes = setNodes.concat(findAllGlobalSetNodes(node.subgraph));
    }
    return setNodes;
}

// THE BROADCASTER: Finds all Get nodes and forces them to update their Vue UI arrays
// We call this whenever a Set node changes its name, type, or existence.
function triggerGetNodeRefresh() {
    const root = app.graph?.rootGraph || app.graph;
    if (!root) return;

    // Recursive walk to hit every Get node in the main graph and subgraphs
    function updateGets(graph) {
        if (!graph || !graph._nodes) return;
        for (const n of graph._nodes) {
            if (n.type === "GlobalGet" && typeof n.refreshState === "function") {
                n.refreshState();
            }
            if (n.subgraph) updateGets(n.subgraph);
        }
    }
    updateGets(root);
    
    // Force the canvas to redraw to reflect the new state visually
    if (app.graph && typeof app.graph.setDirtyCanvas === "function") {
        app.graph.setDirtyCanvas(true, true);
    }
}

app.registerExtension({
    name: "Comfy.GlobalVariables.SetNode",
    registerCustomNodes() {
        class GlobalSet extends LiteGraph.LGraphNode {
            constructor() {
                super();
                this.title = "Global Set";
                this.category = "Global Variables";

                this.isVirtualNode = true;
                this.serialize_widgets = true;
                this.properties = { "Node name for S&R": "GlobalSet" };

                this.addInput("value", "*");

                this.addWidget("text", "variable_name", "", () => {
                    // LIVE TYPING: do NOT rewrite the value here. The old code ran
                    // getUniqueName() on every keystroke and wrote the result back,
                    // so typing a name that starts like an existing one instantly
                    // became "name_0" and you couldn't finish typing. We now only
                    // refresh the title live and defer de-duplication until the edit
                    // actually ends (blur / Enter / click outside the node).
                    this.updateTitle();
                    this.attachNameCommitHandler();
                });
            }

            // De-duplicate the name, but ONLY when the user has finished editing.
            // Called from the commit handler (blur/Enter), onDeselected, etc.
            normalizeName() {
                if (this._nameCommitTimer) {
                    clearTimeout(this._nameCommitTimer);
                    this._nameCommitTimer = null;
                }
                const w = this.widgets?.[0];
                if (!w) return;
                const raw = (w.value || "").trim();
                const unique = raw === "" ? "" : this.getUniqueName(raw);
                if (w.value !== unique) w.value = unique;
                this.updateTitle();
                this.setDirtyCanvas?.(true, true);
                
                // BROADCAST: The user finished typing a new name, tell the Get nodes!
                triggerGetNodeRefresh();
            }

            // Bind a one-shot commit handler to the active inline text editor so the
            // name is normalized exactly when the edit ends — not while typing.
            // blur fires on both Enter and click-away in ComfyUI's inline editor.
            attachNameCommitHandler() {
                const el = typeof document !== "undefined" ? document.activeElement : null;
                const isEditor = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
                if (!isEditor) {
                    // No live inline editor (commit-only widget): value is already final.
                    this._nameCommitTimer = setTimeout(() => this.normalizeName(), 0);
                    return;
                }
                if (el._gvCommitBound) return;
                el._gvCommitBound = true;
                const commit = () => {
                    el.removeEventListener("blur", commit);
                    el.removeEventListener("change", commit);
                    el._gvCommitBound = false;
                    // Defer so the editor writes its final value into the widget first.
                    setTimeout(() => this.normalizeName(), 0);
                };
                el.addEventListener("blur", commit);
                el.addEventListener("change", commit);
            }

            // Backstop: clicking outside the node commits the name immediately.
            onDeselected() {
                this.normalizeName();
            }

            // Centralized helper to guarantee NO duplicates exist on the canvas
            getUniqueName(desiredName) {
                if (!desiredName) return "";
                const allSetNames = new Set();
                const root = app.graph?.rootGraph || app.graph;
                // Depth-complete walk: every GlobalSet at any subgraph nesting depth.
                for (const n of findAllGlobalSetNodes(root)) {
                    // Don't count ourselves
                    if (n !== this && n.widgets?.[0]) {
                        allSetNames.add(n.widgets[0].value);
                    }
                }

                // If it's unique, keep it
                if (!allSetNames.has(desiredName)) return desiredName;

                // Strip existing suffix if it has one (e.g., turn "1_1" into "1")
                let baseName = desiredName;
                const match = desiredName.match(/^(.*)_(\d+)$/);
                if (match) {
                    baseName = match[1];
                }

                // Append an incrementing number starting at 0 (e.g. 1_0 -> 1_1 -> 1_2)
                let counter = 0;
                while (allSetNames.has(`${baseName}_${counter}`)) {
                    counter++;
                }
                return `${baseName}_${counter}`;
            }

            // Centralized helper to dynamically build the title
            updateTitle() {
                const val = this.widgets?.[0]?.value?.trim() || "";
                const type = this.inputs?.[0]?.type;
                const typeDisplay = (type && type !== "*") ? String(type).toUpperCase() : "";

                if (val === "") {
                    this.title = typeDisplay ? "Global Set " + typeDisplay : "Global Set";
                } else {
                    this.title = typeDisplay ? "Set " + typeDisplay + ": " + val : "Set: " + val;
                }
            }

            // BROADCAST: A new Set node appeared on the canvas! 
            onAdded() {
                triggerGetNodeRefresh();
            }

            // BROADCAST: A Set node was deleted! Wait a tiny bit for it to clear memory, then tell the Get nodes.
            onRemoved() {
                setTimeout(() => triggerGetNodeRefresh(), 10);
            }

            // Alt+Drag Cloning
            onCloned() {
                // 1. Force Unlock Type
                this.inputs[0].type = "*";
                this.inputs[0].name = "value";

                // 2. Append number instead of wiping
                if (this.widgets?.[0]) {
                    let currentName = this.widgets[0].value;
                    if (currentName !== "") {
                        this.widgets[0].value = this.getUniqueName(currentName);
                    }
                }
                this.updateTitle();
                
                // BROADCAST: A duplicate was just created!
                triggerGetNodeRefresh();
            }

            // Ctrl+C / Ctrl+V Cloning & Loading workflows
            onConfigure(info) {
                super.onConfigure?.(info);

                let currentName = this.widgets?.[0]?.value || "";
                if (currentName === "my_var") currentName = ""; // Wipe legacy python default

                // Delay slightly to let the graph fully populate before resolving duplicates
                setTimeout(() => {
                    if (currentName !== "") {
                        currentName = this.getUniqueName(currentName);
                        if (this.widgets?.[0]) {
                            this.widgets[0].value = currentName;
                        }
                    }

                    // Unlock the type if it was saved disconnected
                    if (this.inputs[0] && this.inputs[0].link == null) {
                        this.inputs[0].type = "*";
                        this.inputs[0].name = "value";
                    }
                    this.updateTitle();
                    
                    // BROADCAST: Workflow finished loading or node pasted, refresh gets!
                    triggerGetNodeRefresh();
                }, 10);
            }

            onConnectionsChange(slotType, slot, isChangeConnect, link_info) {
                if (slotType === LiteGraph.INPUT && slot === 0) {

                    // Unplugged: Revert to wildcard, keep text box name, update title
                    if (!isChangeConnect) {
                        this.inputs[0].type = "*";
                        this.inputs[0].name = "value";
                        this.updateTitle();
                    }
                    // Plugged in: Steal the wire type, update title
                    else if (link_info && this.graph) {
                        const originNode = this.graph.getNodeById(link_info.origin_id);

                        if (originNode && originNode.outputs[link_info.origin_slot]) {
                            const newType = originNode.outputs[link_info.origin_slot].type;
                            this.inputs[0].type = newType;
                            this.inputs[0].name = newType;

                            this.updateTitle();
                        }
                    }
                    
                    // BROADCAST: The type changed, so we need to tell Get nodes so they can filter out mismatched types
                    triggerGetNodeRefresh();
                }
            }
        }
        LiteGraph.registerNodeType("GlobalSet", GlobalSet);
    }
});