import cv2
import numpy as np
from PIL import Image, ImageOps
import io


def order_points(pts: np.ndarray) -> np.ndarray:
    """
    Orders 4 coordinates in: [top-left, top-right, bottom-right, bottom-left].
    """
    rect = np.zeros((4, 2), dtype="float32")
    pts = pts.reshape(4, 2)

    # Top-left has smallest sum, bottom-right has largest sum
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]

    # Top-right has smallest diff (x - y), bottom-left has largest diff
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]

    return rect


def four_point_transform(image: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """
    Performs 4-point perspective warp on the input image.
    """
    rect = order_points(pts)
    (tl, tr, br, bl) = rect

    # Compute width of new image
    width_a = np.sqrt(((br[0] - bl[0]) ** 2) + ((br[1] - bl[1]) ** 2))
    width_b = np.sqrt(((tr[0] - tl[0]) ** 2) + ((tr[1] - tl[1]) ** 2))
    max_width = max(int(width_a), int(width_b))

    # Compute height of new image
    height_a = np.sqrt(((tr[0] - br[0]) ** 2) + ((tr[1] - br[1]) ** 2))
    height_b = np.sqrt(((tl[0] - bl[0]) ** 2) + ((tl[1] - bl[1]) ** 2))
    max_height = max(int(height_a), int(height_b))

    # Guard against zero dimension
    max_width = max(max_width, 100)
    max_height = max(max_height, 100)

    dst = np.array([
        [0, 0],
        [max_width - 1, 0],
        [max_width - 1, max_height - 1],
        [0, max_height - 1]
    ], dtype="float32")

    M = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(image, M, (max_width, max_height), flags=cv2.INTER_LINEAR)
    return warped


def find_document_quad(image: np.ndarray) -> np.ndarray | None:
    """
    Detects largest quadrilateral contour representing document (>15% area).
    Uses convex hull + adaptive epsilon polygon approximation with minAreaRect fallback.
    """
    orig_h, orig_w = image.shape[:2]

    # Downscale for edge detection to avoid micro-textures/noise
    proc_w = 600
    scale = orig_w / proc_w
    proc_h = int(orig_h / scale)
    small = cv2.resize(image, (proc_w, proc_h), interpolation=cv2.INTER_AREA)

    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    # Edge detection
    edges = cv2.Canny(blurred, 40, 150)

    # Close small edge gaps
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    dilated = cv2.dilate(edges, kernel, iterations=2)

    contours, _ = cv2.findContours(dilated, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    # Sort contours by area descending
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:5]
    min_area_thresh = 0.15 * (proc_w * proc_h)

    for c in contours:
        area = cv2.contourArea(c)
        if area < min_area_thresh:
            continue

        hull = cv2.convexHull(c)
        peri = cv2.arcLength(hull, True)

        # Try multiple epsilons to find clean 4 points
        for eps in np.linspace(0.015, 0.085, 15):
            approx = cv2.approxPolyDP(hull, eps * peri, True)
            if len(approx) == 4 and cv2.isContourConvex(approx):
                return approx.reshape(4, 2) * scale

        # Fallback to minAreaRect if hull has extra noisy corners
        rect = cv2.minAreaRect(hull)
        box = cv2.boxPoints(rect)
        return box * scale

    return None


def enhance_bw(image: np.ndarray) -> np.ndarray:
    """
    Applies adaptive thresholding for clear, high-contrast B&W document scan.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    
    # Adaptive threshold: blockSize must be odd (21), C=10
    thresh = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 21, 10
    )

    # Mild text sharpening
    kernel = np.array([[0, -0.5, 0], [-0.5, 3.0, -0.5], [0, -0.5, 0]], dtype=np.float32)
    sharpened = cv2.filter2D(thresh, -1, kernel)
    return sharpened


def enhance_color(image: np.ndarray) -> np.ndarray:
    """
    Applies divide normalization (Retinex) and saturation boost for Magic Color mode.
    """
    # Background illumination estimation via large Gaussian blur
    blur = cv2.GaussianBlur(image, (51, 51), 0)
    
    # Avoid zero division
    blur = np.clip(blur, 20, 255)

    # Divide normalization: (image / blur) * 255
    norm = cv2.divide(image, blur, scale=255)

    # Levels stretching (black point 25, white point 225)
    norm = np.clip((norm.astype(np.float32) - 25) * (255.0 / (225.0 - 25.0)), 0, 255).astype(np.uint8)

    # Saturation pop for stamps/signatures
    hsv = cv2.cvtColor(norm, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[..., 1] = np.clip(hsv[..., 1] * 1.25, 0, 255)
    result = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)

    # Mild unsharp mask
    gaussian = cv2.GaussianBlur(result, (0, 0), 1.5)
    sharpened = cv2.addWeighted(result, 1.2, gaussian, -0.2, 0)
    return sharpened


def process_image(image_bytes: bytes, mode: str = "bw") -> bytes:
    """
    Full document processing pipeline:
    1. Load image and auto-orient with EXIF
    2. Resize max 1800px preserving aspect ratio
    3. Document contour detection and four-point perspective warp
    4. Adaptive thresholding (bw) or Retinex normalization (color)
    5. Encode to JPEG quality 88
    """
    # 1. Load image safely using Pillow to handle EXIF orientation
    pil_img = Image.open(io.BytesIO(image_bytes))
    pil_img = ImageOps.exif_transpose(pil_img)
    
    if pil_img.mode != "RGB":
        pil_img = pil_img.convert("RGB")

    orig_img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)

    # 2. Resize max 1800px
    h, w = orig_img.shape[:2]
    max_dim = max(h, w)
    if max_dim > 1800:
        scale = 1800.0 / max_dim
        new_w = int(w * scale)
        new_h = int(h * scale)
        orig_img = cv2.resize(orig_img, (new_w, new_h), interpolation=cv2.INTER_AREA)

    # 3. Quadrilateral document contour detection
    quad = find_document_quad(orig_img)

    # 4. Perspective warp if document boundary found
    if quad is not None:
        processed = four_point_transform(orig_img, quad)
    else:
        # Graceful fallback: keep full image if no distinct quad found
        processed = orig_img

    # 5. Apply enhancement filter
    if mode.lower() in ("color", "magic"):
        final_img = enhance_color(processed)
    else:
        final_img = enhance_bw(processed)

    # 6. Encode to JPEG quality 88
    encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), 88]
    success, encoded = cv2.imencode(".jpg", final_img, encode_params)
    if not success:
        raise ValueError("Failed to encode processed image to JPEG")

    return encoded.tobytes()
