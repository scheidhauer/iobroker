import os
import glob
import re
from google import genai

# Mac-spezifische native Bibliotheken für PDF und OCR
import Quartz
import Vision
from Cocoa import NSURL

# 1. DYNAMISCHE PFADERKENNUNG
# Wo liegt dieses Skript? (Unterordner 'pdf_umbenennen')
SKRIPT_ORDNER = os.path.dirname(os.path.abspath(__file__))
# Wo liegen die PDFs? (Ein Ordner darüber, also parallel zum Unterordner)
ORDNER_PFAD = os.path.dirname(SKRIPT_ORDNER)

try:
    from dotenv import load_dotenv
    # Lädt die .env direkt aus dem Skript-Ordner
    load_dotenv(os.path.join(SKRIPT_ORDNER, ".env"))
except ImportError:
    pass

API_KEY = os.getenv("GEMINI_API_KEY")

if not API_KEY:
    raise ValueError(
        f"Fehler: Die Umgebungsvariable 'GEMINI_API_KEY' wurde nicht gefunden!\n"
        f"Bitte erstelle eine '.env' Datei im Ordner: {SKRIPT_ORDNER}"
    )

client = genai.Client(api_key=API_KEY)

def mac_ocr_cgimage(cg_image):
    """Nutzt die native macOS Texterkennung (Live Text) direkt mit einem CGImage im RAM"""
    request_handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg_image, None)
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    
    success, error = request_handler.performRequests_error_([request], None)
    if not success:
        return ""
        
    results = request.results()
    text = ""
    for result in results:
        candidates = result.topCandidates_(1)
        if candidates:
            text += candidates[0].string() + "\n"
    return text

def pdf_page_to_cgimage(pdf_page, dpi=150):
    """Rendert eine PDFPage im RAM in ein CGImage"""
    media_box = pdf_page.boundsForBox_(0) # 0 = kPDFDisplayBoxMediaBox
    width = int(media_box.size.width * (dpi / 72.0))
    height = int(media_box.size.height * (dpi / 72.0))

    color_space = Quartz.CGColorSpaceCreateDeviceRGB()
    context = Quartz.CGBitmapContextCreate(
        None, width, height, 8, 0, color_space, 
        Quartz.kCGImageAlphaPremultipliedLast
    )

    if not context:
        return None

    # Weißer Hintergrund
    Quartz.CGContextSetRGBFillColor(context, 1.0, 1.0, 1.0, 1.0)
    Quartz.CGContextFillRect(context, Quartz.CGRectMake(0, 0, width, height))

    # Skalierung für DPI
    Quartz.CGContextScaleCTM(context, dpi / 72.0, dpi / 72.0)

    # PDF-Seite in den Grafikkontext zeichnen
    pdf_page.drawWithBox_toContext_(0, context)

    # CGImage erstellen
    cg_image = Quartz.CGBitmapContextCreateImage(context)
    return cg_image

def extrahiere_text(pdf_pfad):
    """Versucht erst digitalen Text zu lesen (nativ über PDFKit), falls leer -> native OCR im RAM"""
    url = NSURL.fileURLWithPath_(pdf_pfad)
    pdf_doc = Quartz.PDFDocument.alloc().initWithURL_(url)
    
    if not pdf_doc or pdf_doc.pageCount() == 0:
        return ""
        
    page = pdf_doc.pageAtIndex_(0)
    
    # 1. Versuche, digitalen Text nativ zu extrahieren
    text = page.string() or ""
    
    # 2. Falls kein digitaler Text vorhanden ist -> OCR auf der ersten Seite ausführen
    if not text.strip():
        cg_image = pdf_page_to_cgimage(page, dpi=150)
        if cg_image:
            text = mac_ocr_cgimage(cg_image)
            
    return text

def generiere_dateiname(text_inhalt):
    """Schickt den Text an Gemini für den Namensvorschlag"""
    prompt = f"""
    Analysiere den folgenden Text aus einem gescannten Dokument. 
    Erstelle einen sinnvollen, kurzen und prägnanten Dateinamen für eine PDF.
    Nutze STRENG das Format: JJJJ-MM-TT_Absender_Thema
    Wenn kein Datum erkennbar ist, nutze 2026-00-00.
    Antworte NUR mit dem reinen Dateinamen (inklusive .pdf am Ende), ohne Formatierung, ohne Markdown, ohne Anführungszeichen.
    
    Text:
    {text_inhalt[:2000]}
    """
    
    response = client.models.generate_content(
        model='gemini-2.5-flash',
        contents=prompt,
    )
    return response.text.strip()

def bereinige_und_sichere_dateiname(neuer_name):
    """Extrahiert das Zielmuster aus der Gemini-Antwort und bereinigt illegale Zeichen"""
    # Suche gezielt nach dem Muster YYYY-MM-DD_...pdf
    match = re.search(r"\d{4}-\d{2}-\d{2}_[^\s/\\:*?\"<>|]+\.pdf", neuer_name, re.IGNORECASE)
    if match:
        name = match.group(0)
    else:
        # Fallback: Entferne Markdown-Reste und bereinige
        name = neuer_name.strip("`'\" \n\r\t")
        if not name.lower().endswith(".pdf"):
            name += ".pdf"
        name = "".join(c for c in name if c.isalnum() or c in ".-_")
    return name

def finde_freien_dateinamen(ziel_ordner, gewuenschter_name):
    """Prüft, ob der Dateiname bereits existiert, und hängt ggf. einen Zähler an (z.B. _1, _2)"""
    basis, endung = os.path.splitext(gewuenschter_name)
    neuer_name = gewuenschter_name
    counter = 1
    
    while os.path.exists(os.path.join(ziel_ordner, neuer_name)):
        neuer_name = f"{basis}_{counter}{endung}"
        counter += 1
        
    return neuer_name

def main():
    # Sucht alle PDF-Dateien im übergeordneten Ordner
    such_muster = os.path.join(ORDNER_PFAD, "*.pdf")
    pdf_dateien = glob.glob(such_muster)
    
    # Regex für das Scan-Format: epsonJJJJMMTT_HHMMSS.pdf
    scan_muster = re.compile(r"^epson\d{8}_\d{6}\.pdf$")

    print(f"Scanne Ordner nach PDFs: {ORDNER_PFAD}")
    
    # Filtere Dateien
    zu_verarbeiten = [f for f in pdf_dateien if scan_muster.match(os.path.basename(f))]

    print(f"{len(zu_verarbeiten)} passende Epson-PDFs gefunden.")

    for pfad in zu_verarbeiten:
        try:
            print(f"Verarbeite: {os.path.basename(pfad)}...")
            text = extrahiere_text(pfad)
            
            if not text.strip():
                print("Kein Text gefunden. Überspringe.")
                continue
                
            raw_neuer_name = generiere_dateiname(text)
            neuer_name = bereinige_und_sichere_dateiname(raw_neuer_name)
            
            sicherer_name = finde_freien_dateinamen(ORDNER_PFAD, neuer_name)
            neuer_pfad = os.path.join(ORDNER_PFAD, sicherer_name)
            
            os.rename(pfad, neuer_pfad)
            print(f"Umbenannt in: {sicherer_name}")
            
        except Exception as e:
            print(f"Fehler bei {os.path.basename(pfad)}: {e}")

if __name__ == "__main__":
    main()
