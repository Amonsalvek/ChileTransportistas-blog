#!/usr/bin/env python3
import os
import datetime

BLOG_PATH = "/var/www/blog"
BASE_URL = "https://blog.chiletransportistas.com"
OUTPUT_FILE = os.path.join(BLOG_PATH, "sitemap-blog.xml")

def generate_sitemap():
    urls = []
    now = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S+00:00")

    for root, _, files in os.walk(BLOG_PATH):
        for f in files:
            if f.endswith(".html"):
                path = os.path.join(root, f)
                rel_path = os.path.relpath(path, BLOG_PATH)
                url = f"{BASE_URL}/{rel_path}".replace("index.html", "").replace("\\", "/")
                mod_time = datetime.datetime.utcfromtimestamp(os.path.getmtime(path)).strftime("%Y-%m-%d")
                urls.append((url, mod_time))

    sitemap = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="https://www.sitemaps.org/schemas/sitemap/0.9">'
    ]
    for url, mod in sorted(urls):
        sitemap.append("  <url>")
        sitemap.append(f"    <loc>{url}</loc>")
        sitemap.append(f"    <lastmod>{mod}</lastmod>")
        sitemap.append("  </url>")
    sitemap.append("</urlset>")

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(sitemap))

    print(f"Sitemap actualizado: {OUTPUT_FILE}")

if __name__ == "__main__":
    generate_sitemap()