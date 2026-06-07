from comfy_api.latest import ComfyExtension, io

# Tells ComfyUI to serve the JavaScript files in the "web" folder to the browser.
WEB_DIRECTORY = "./web"

class GlobalVariablesExtension(ComfyExtension):
    # We MUST include this method to satisfy the V3 API abstract class.
    # We return an empty list because our nodes are 100% frontend JavaScript, 
    # meaning the Python backend never needs to execute them and they can never crash.
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return []

async def comfy_entrypoint() -> GlobalVariablesExtension:
    return GlobalVariablesExtension()
