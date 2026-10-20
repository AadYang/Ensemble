#!/usr/bin/env python3
from pathlib import Path

p = Path("/etc/nginx/sites-available/ensemble.conf")
text = p.read_text()
if "location ^~ /postoffice/" in text:
    updated = text.replace("proxy_read_timeout 120s;", "proxy_read_timeout 900s;")
    if updated != text:
        p.write_text(updated)
        print("updated postoffice proxy_read_timeout to 900s")
    else:
        print("nginx already has /postoffice/")
    raise SystemExit(0)

snippet = """
    location = /postoffice { return 301 /postoffice/; }
    location ^~ /postoffice/ {
        proxy_pass http://127.0.0.1:8790/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization $http_authorization;
        proxy_read_timeout 900s;
        proxy_buffering off;
        client_max_body_size 16m;
    }

"""
needle_apex = "    # The public apex root must land"
www = "    location / {\n        try_files $uri $uri/ /index.html;"
if needle_apex not in text or www not in text:
    raise SystemExit("unexpected nginx.conf shape; refusing to patch")
text = text.replace(needle_apex, snippet + needle_apex, 1)
text = text.replace(www, snippet + www, 1)
p.write_text(text)
print("patched nginx")
