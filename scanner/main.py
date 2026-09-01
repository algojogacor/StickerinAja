from fastapi import FastAPI, UploadFile, File, Query, HTTPException
from fastapi.responses import Response
import logging
from processor import process_image

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("document-scanner")

app = FastAPI(title="Document Scanner Microservice", version="1.0.0")


@app.get("/health")
def health_check():
    return {"status": "ok", "service": "document-scanner"}


@app.post("/scan")
async def scan_document(
    image: UploadFile = File(..., description="Document image file"),
    mode: str = Query(default="bw", pattern="^(bw|color|magic)$", description="Scanning mode: bw or color")
):
    try:
        content = await image.read()
        if not content:
            raise HTTPException(status_code=400, detail="Empty image uploaded")

        logger.info(f"Received scan request: filename={image.filename}, size={len(content)} bytes, mode={mode}")
        
        output_bytes = process_image(content, mode=mode)

        logger.info(f"Scan successful: output_size={len(output_bytes)} bytes")
        return Response(content=output_bytes, media_type="image/jpeg")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error processing document: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Image processing error: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
