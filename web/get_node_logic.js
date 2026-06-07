import { app } from "../../scripts/app.js";

// Depth-complete enumeration of every GlobalSet node in the document.
// Walks the live instance tree (node.subgraph) recursively, so setters nested
// inside subgraphs-within-subgraphs at ANY depth are found. Each returned node
// keeps its own .graph reference, used below for link resolution.
function findAllGlobalSetNodes(graph) {
    let setNodes = [];
    if (!graph || !graph._nodes) return setNodes;
    for (const node of graph._nodes) {
        if (node.type === "GlobalSet") setNodes.push(node);
        if (node.subgraph) setNodes = setNodes.concat(findAllGlobalSetNodes(node.subgraph));
    }
    return setNodes;
}

app.registerExtension({
    name: "Comfy.GlobalVariables.GetNode",

    // PHASE 1 & 2: THE INITIAL CHECK & THE EVENT LISTENER
    // We use setup() because it runs exactly once after the ComfyUI interface loads.
    setup() {
        // Helper function to force all Get nodes to update their Vue UI arrays
        const updateAllGetNodes = () => {
            const root = app.graph?.rootGraph || app.graph;
            if (!root) return;

            // Recursive walk to find every Get node, even in subgraphs
            function refreshGets(graph) {
                if (!graph || !graph._nodes) return;
                for (const n of graph._nodes) {
                    if (n.type === "GlobalGet" && typeof n.refreshState === "function") {
                        n.refreshState();
                    }
                    if (n.subgraph) refreshGets(n.subgraph);
                }
            }
            refreshGets(root);
            
            // Tell the canvas to redraw if needed
            if (app.graph && typeof app.graph.setDirtyCanvas === "function") {
                app.graph.setDirtyCanvas(true, true);
            }
        };

        // THE EVENT LISTENER (Phase 2): Listen for the user flipping the Nodes 2.0 toggle
        if (app.ui && app.ui.settings) {
            app.ui.settings.addEventListener("Comfy.VueNodes.Enabled.change", () => {
                // Slight delay to let the Vue interface finish mounting/unmounting
                setTimeout(updateAllGetNodes, 50);
            });
        }
        
        // Note: The Initial Check (Phase 1) happens naturally because when the graph loads
        // or a node is placed, onAdded/onConfigure runs and calls refreshState() automatically.
    },

    registerCustomNodes() {
        class GlobalGet extends LiteGraph.LGraphNode {
            constructor() {
                super();
                this.title = "Global Get";
                this.category = "Global Variables";
                this.isVirtualNode = true;
                this.serialize_widgets = true;
                this.properties = { "Node name for S&R": "GlobalGet" };

                this.addOutput("output", "*");

                // We use a standard array for the combo widget now instead of Object.defineProperty
                this.addWidget("combo", "variable_name", "", (v) => {
                    this.title = v && v !== "" ? "Get: " + v : "Global Get";
                    this.refreshState(); // Update type safely if user changes target
                }, { values: [""] });

                // ACTIVE REFRESH: This replaces the old Object.defineProperty getter.
                // It calculates the available Set nodes and explicitly pushes the array
                // into the widget options so the strict Vue UI detects the change.
                this.refreshState = () => {
                    if (!this.graph) return;

                    let requiredType = null;
                    if (this.outputs?.[0]?.links?.length) {
                        for (const linkId of this.outputs[0].links) {
                            const link = this.graph.getLink ? this.graph.getLink(linkId) : this.graph.links[linkId];
                            if (link) {
                                const targetNode = this.graph.getNodeById(link.target_id);
                                const tType = targetNode?.inputs?.[link.target_slot]?.type;
                                if (tType && tType !== "*") {
                                    requiredType = String(tType).toUpperCase();
                                    break;
                                }
                            }
                        }
                    }

                    const setNames = new Set();
                    const root = app.graph?.rootGraph || app.graph;

                    // Depth-complete walk: every GlobalSet at any nesting depth.
                    for (const n of findAllGlobalSetNodes(root)) {
                        const setName = n.widgets?.[0]?.value;
                        if (!setName || setName === "my_var" || setName === "") continue;

                        const ng = n.graph;
                        if (!ng) continue;

                        let providedType = null;
                        if (n.inputs?.[0]?.link != null) {
                            const link = ng.getLink ? ng.getLink(n.inputs[0].link) : ng.links[n.inputs[0].link];
                            if (link) {
                                const originNode = ng.getNodeById(link.origin_id);
                                const oType = originNode?.outputs?.[link.origin_slot]?.type;
                                if (oType && oType !== "*") {
                                    providedType = String(oType).toUpperCase();
                                }
                            }
                        }

                        if (!requiredType) {
                            setNames.add(setName);
                        } else if (providedType) {
                            const reqTypes = requiredType.split(",");
                            const provTypes = providedType.split(",");
                            if (reqTypes.some(rt => provTypes.includes(rt))) {
                                setNames.add(setName);
                            }
                        }
                    }

                    const sorted = ["", ...Array.from(setNames).sort()];
                    
                    // PHYSICALLY update the array. This forces the V2 UI to react.
                    if (this.widgets?.[0]) {
                        this.widgets[0].options.values = sorted;
                    }

                    // Refresh Title
                    const val = this.widgets?.[0]?.value;
                    if (val && val !== "my_var" && val !== "") {
                        this.title = "Get: " + val;
                    } else {
                        this.title = "Global Get";
                    }
                };
            }

            // When physically placed on the canvas, initialize the state
            onAdded() {
                this.refreshState();
            }

            // TYPE LOCKING & WIPE ON DISCONNECT
            onConnectionsChange(slotType, slot, isChangeConnect, link_info) {
                if (slotType === LiteGraph.OUTPUT && slot === 0) {
                    if (isChangeConnect && link_info && this.graph) {
                        // 1. If connected, permanently lock the output to that target type
                        const targetNode = this.graph.getNodeById(link_info.target_id);
                        if (targetNode && targetNode.inputs[link_info.target_slot]) {
                            const targetType = targetNode.inputs[link_info.target_slot].type;
                            if (targetType && targetType !== "*") {
                                this.outputs[0].type = targetType;
                                this.outputs[0].name = targetType;
                            }
                        }
                    } else if (!isChangeConnect) {
                        // 2. If a wire was removed, check if it's completely unplugged
                        const hasLinks = this.outputs?.[0]?.links?.length > 0;
                        if (!hasLinks) {
                            // Revert to wildcard, wipe the text, and reset the title
                            this.outputs[0].type = "*";
                            this.outputs[0].name = "output";
                            if (this.widgets?.[0]) {
                                this.widgets[0].value = "";
                            }
                            this.title = "Global Get";
                        }
                    }
                    // Trigger an update to the dropdown list in case the type lock changed what variables are valid
                    this.refreshState();
                }
            }

            onCloned() {
                // Ensure clones start completely blank as wildcards
                this.outputs[0].type = "*";
                this.outputs[0].name = "output";
                if (this.widgets?.[0]) {
                    this.widgets[0].value = "";
                }
                this.title = "Global Get";
            }

            onConfigure(info) {
                super.onConfigure?.(info);

                const hasLinks = this.outputs?.[0]?.links?.length > 0;
                if (!hasLinks) {
                    this.outputs[0].type = "*";
                    this.outputs[0].name = "output";
                    if (this.widgets?.[0]) this.widgets[0].value = "";
                    this.title = "Global Get";
                } else {
                    const val = this.widgets?.[0]?.value;
                    if (val && val !== "my_var" && val !== "") {
                        this.title = "Get: " + val;
                    } else {
                        this.title = "Global Get";
                        if (this.widgets?.[0]) this.widgets[0].value = "";
                    }
                }
                
                // Delay slightly to let the graph fully populate before resolving available variables
                setTimeout(() => this.refreshState(), 10);
            }

            // Core routing: SAME-GRAPH ONLY.
            // Cross-graph wiring is handled by resolveVirtualOutput + the
            // graphToPrompt patch below. This must NOT be broadened to the whole
            // tree: a returned link's origin_id is only resolvable inside this.graph,
            // so a foreign-graph link would break single-graph resolution.
            getInputLink(slot) {
                const requestedVar = this.widgets?.[0]?.value;
                if (!requestedVar || requestedVar === "my_var" || requestedVar === "") return null;

                const setter = this.graph?._nodes?.find(n =>
                    n.type === "GlobalSet" && n.widgets?.[0]?.value === requestedVar
                );

                if (setter) {
                    const slotInfo = setter.inputs[0];
                    if (!slotInfo || slotInfo.link == null) return null;
                    return this.graph.getLink ? this.graph.getLink(slotInfo.link) : this.graph.links[slotInfo.link];
                }
                return null;
            }

            // Core routing: CROSS-GRAPH ONLY (bridge for subgraph boundaries).
            // Deliberately bails when the setter is in this.graph, leaving the
            // same-graph case to getInputLink above.
            resolveVirtualOutput(slot) {
                const requestedVar = this.widgets?.[0]?.value;
                if (!requestedVar || requestedVar === "my_var" || requestedVar === "") return undefined;

                const root = app.graph?.rootGraph || app.graph;
                const setter = findAllGlobalSetNodes(root).find(n =>
                    n.widgets?.[0]?.value === requestedVar
                );

                if (!setter || !setter.graph || setter.graph === this.graph) return undefined;

                const setterGraph = setter.graph;
                const slotInfo = setter.inputs[0];
                if (!slotInfo || slotInfo.link == null) return undefined;

                const link = setterGraph.getLink ? setterGraph.getLink(slotInfo.link) : setterGraph.links[slotInfo.link];
                if (!link) return undefined;

                const sourceNode = setterGraph.getNodeById(link.origin_id);
                if (!sourceNode) return undefined;

                return { node: sourceNode, slot: link.origin_slot };
            }
        }

        LiteGraph.registerNodeType("GlobalGet", GlobalGet);
    }
});

// SUBGRAPH SAFETY PATCH
// Lets a GlobalGet inside a subgraph pull from a GlobalSet outside it at
// prompt-generation time, by teaching the flattened execution DTOs to consult
// resolveVirtualOutput. Hardened with null-safety guards; any failure inside the
// patched resolver degrades gracefully to standard LiteGraph routing.
app.registerExtension({
    name: "Comfy.GlobalVariables.CrossGraphPatch",
    setup() {
        let patched = false;

        if (typeof app.graphToPrompt !== "function") return;

        const originalGraphToPrompt = app.graphToPrompt.bind(app);

        app.graphToPrompt = async function (...args) {
            if (!patched && app.graph && app.graph._nodes) {
                try {
                    const subgraphNode = app.graph._nodes.find(
                        (n) => typeof n.getInnerNodes === "function"
                    );
                    if (subgraphNode) {
                        const dtos = subgraphNode.getInnerNodes(new Map(), []);
                        if (dtos && dtos.length > 0) {
                            const proto = Object.getPrototypeOf(dtos[0]);
                            if (proto && typeof proto.resolveOutput === "function") {
                                const DtoClass = proto.constructor;

                                if (!proto.resolveOutput.toString().includes("resolveVirtualOutput")) {
                                    const origResolveOutput = proto.resolveOutput;

                                    proto.resolveOutput = function (slot, type, visited) {
                                        try {
                                            // If the node has our custom cross-graph bridge, use it
                                            if (this.node && typeof this.node.resolveVirtualOutput === "function") {
                                                const virtualSource = this.node.resolveVirtualOutput(slot);
                                                if (virtualSource && this.nodesByExecutionId) {
                                                    const inputNodeDto = [...this.nodesByExecutionId.values()].find(
                                                        (dto) => dto instanceof DtoClass && dto.node === virtualSource.node
                                                    );
                                                    if (inputNodeDto && typeof inputNodeDto.resolveOutput === "function") {
                                                        return inputNodeDto.resolveOutput(virtualSource.slot, type, visited);
                                                    }
                                                }
                                            }
                                        } catch (err) { }
                                        // Fallback to standard LiteGraph routing
                                        return origResolveOutput.apply(this, [slot, type, visited]);
                                    };
                                }

                                // Only mark done once we have a valid prototype to patch
                                // (or it is already patched). If the graph isn't ready yet,
                                // leave patched=false so the next prompt retries.
                                patched = true;
                            }
                        }
                    }
                } catch (e) {
                    // Leave patched=false so a later graphToPrompt retries.
                }
            }
            return originalGraphToPrompt(...args);
        };
    }
});