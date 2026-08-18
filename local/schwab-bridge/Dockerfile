FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py db.py vault.py ./

# Container-internal paths — docker-compose.yml bind-mounts the real files here.
ENV SOURCE_DB_PATH=/data/source/trades.db \
    VAULT_DB_PATH=/data/vault/vault.db \
    BRIDGE_HOST=0.0.0.0 \
    BRIDGE_PORT=8000

EXPOSE 8000
CMD ["python", "main.py"]
