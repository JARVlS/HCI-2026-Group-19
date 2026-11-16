# Worker entry point. Everything else lives in app.py and the modules it imports.
from workers import asgi

from app import app

Default = asgi.entrypoint(app)
