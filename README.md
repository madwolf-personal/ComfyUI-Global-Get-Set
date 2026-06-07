# ComfyUI Global Get/Set Nodes

A simple set of custom nodes for ComfyUI that lets you pass variables around your workflow without creating a massive, tangled web of spaghetti wires. 

The main feature here is **Global Scope**: these nodes can talk to each other anywhere, including crossing in and out of Subgraphs.

## What's included?

* **Global Set:** Plug any wire into this, and give it a name. It locks onto whatever type of data you plug into it (String, Image, Latent, etc.) and makes it globally available. It also automatically stops you from naming two variables the exact same thing.
* **Global Get:** Slap this anywhere else in your workflow. The dropdown will automatically populate with your available variables. It's smart enough to only let you pull variables that match the type of wire you're trying to connect it to.

## Features

* **Subgraph Support:** A `Set` node inside a subgraph can talk to a `Get` node completely outside of it (and vice versa). 
* **Auto-updating Dropdowns:** If you rename a variable on a Set node, the Get nodes update instantly. 
* **Nodes 2.0 / Vue UI Ready:** Built to work smoothly with the new ComfyUI interface updates.

## How to Install

Clone this repo into your ComfyUI `custom_nodes` folder.

## How to Use
1. Place a **Global Set**, type a name in the box, and plug something into it.
2. Place a **Global Get** somewhere else. 
3. Select the name you just made from the dropdown, and wire it up to your next node.
