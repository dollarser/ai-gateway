"""Single-instance account storage. Never persist raw passwords, keys or sessions."""

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime
from zoneinfo import ZoneInfo

SERVICES = {"qwen", "asr", "tts"}


class Denied(Exception):
    def __init__(self, status, detail):
        self.status, self.detail = status, detail
        super().__init__(detail)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    value = hashlib.scrypt(
        password.encode(),
        salt=bytes.fromhex(salt),
        n=16384,
        r=8,
        p=1,
        maxmem=64 * 1024 * 1024,
    ).hex()
    return salt + ":" + value


def check_password(password, encoded):
    return hmac.compare_digest(password_hash(password, encoded.split(":")[0]), encoded)


class Store:
    def __init__(self, path, recover_leases=True):
        self.lock = threading.RLock()
        self.db = sqlite3.connect(
            str(path), check_same_thread=False, isolation_level=None
        )
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS users(
          id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
          role TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
          services TEXT NOT NULL, rpm INTEGER NOT NULL, daily_requests INTEGER NOT NULL,
          concurrency INTEGER NOT NULL, must_change INTEGER NOT NULL DEFAULT 0,
          created REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS keys(
          id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
          name TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL,
          services TEXT NOT NULL, expires REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
          created REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(
          hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
          csrf TEXT NOT NULL, expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS requests(
          id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
          key_id INTEGER REFERENCES keys(id), service TEXT NOT NULL,
          auth_type TEXT NOT NULL DEFAULT 'api_key',
          path TEXT NOT NULL, started REAL NOT NULL, day TEXT NOT NULL,
          ended REAL, status INTEGER, response_bytes INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS idx_requests_user_time ON requests(user_id,started);
        CREATE INDEX IF NOT EXISTS idx_requests_user_day ON requests(user_id,day);
        CREATE TABLE IF NOT EXISTS inference_auth_failures(ip_hash TEXT NOT NULL, ts REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_inference_auth_ip ON inference_auth_failures(ip_hash,ts);
        CREATE TABLE IF NOT EXISTS login_attempts(ip TEXT NOT NULL, ts REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip,ts);
        CREATE TABLE IF NOT EXISTS audit(
          id INTEGER PRIMARY KEY, actor INTEGER, action TEXT NOT NULL,
          target TEXT NOT NULL, ts REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS registration_attempts(ip_hash TEXT NOT NULL, ts REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_registration_ip ON registration_attempts(ip_hash,ts);
        CREATE TABLE IF NOT EXISTS settings(name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS auth_families(
          id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),
          expires REAL NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS access_tokens(
          hash TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES auth_families(id),expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS refresh_tokens(
          hash TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES auth_families(id),
          expires REAL NOT NULL,used INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS idx_access_family ON access_tokens(family_id);
        CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);
        """)
        # Additive migration: preserve existing account/session/key rows.
        for table, columns in {
            "requests": {
                "prompt_tokens": "INTEGER NOT NULL DEFAULT 0",
                "completion_tokens": "INTEGER NOT NULL DEFAULT 0",
            },
            "keys": {"legacy_daily_tokens": "INTEGER NOT NULL DEFAULT 0"},
        }.items():
            existing = {
                row[1] for row in self.db.execute("PRAGMA table_info(" + table + ")")
            }
            for name, definition in columns.items():
                if name not in existing:
                    self.db.execute(
                        "ALTER TABLE "
                        + table
                        + " ADD COLUMN "
                        + name
                        + " "
                        + definition
                    )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS legacy_token_baseline(key_id INTEGER NOT NULL,day TEXT NOT NULL,prompt_tokens INTEGER NOT NULL,completion_tokens INTEGER NOT NULL,PRIMARY KEY(key_id,day))"
        )
        self.db.execute(
            "INSERT OR IGNORE INTO settings VALUES(?,?)",
            (
                "registration_defaults",
                json.dumps({"rpm": 30, "daily_requests": 1000, "concurrency": 2}),
            ),
        )
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(users)")}
        if "email" not in columns:
            self.db.execute("ALTER TABLE users ADD COLUMN email TEXT")
        self.db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE)"
        )
        session_columns = {
            row[1] for row in self.db.execute("PRAGMA table_info(sessions)")
        }
        if "family_id" not in session_columns:
            self.db.execute("ALTER TABLE sessions ADD COLUMN family_id TEXT")
        request_columns = {
            row[1]: row for row in self.db.execute("PRAGMA table_info(requests)")
        }
        if request_columns["key_id"][3]:
            # Preserve historical request IDs/usage while allowing login-token calls without a key.
            with self.transaction() as db:
                db.execute(
                    "ALTER TABLE requests RENAME TO requests_before_login_tokens"
                )
                db.execute("""CREATE TABLE requests(
                  id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),
                  key_id INTEGER REFERENCES keys(id),service TEXT NOT NULL,
                  auth_type TEXT NOT NULL DEFAULT 'api_key',path TEXT NOT NULL,
                  started REAL NOT NULL,day TEXT NOT NULL,ended REAL,status INTEGER,
                  response_bytes INTEGER NOT NULL DEFAULT 0)""")
                db.execute("""INSERT INTO requests(id,user_id,key_id,service,path,started,day,ended,status,response_bytes)
                  SELECT id,user_id,key_id,service,path,started,day,ended,status,response_bytes
                  FROM requests_before_login_tokens""")
                db.execute("DROP TABLE requests_before_login_tokens")
                db.execute(
                    "CREATE INDEX idx_requests_user_time ON requests(user_id,started)"
                )
                db.execute(
                    "CREATE INDEX idx_requests_user_day ON requests(user_id,day)"
                )
        elif "auth_type" not in request_columns:
            self.db.execute(
                "ALTER TABLE requests ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'api_key'"
            )
        # Single-instance service: interrupted leases are closed on restart.
        if recover_leases:
            self.db.execute(
                "UPDATE requests SET ended=?,status=503 WHERE ended IS NULL",
                (time.time(),),
            )
        if str(path) != ":memory:":
            for suffix in ["", "-wal", "-shm"]:
                try:
                    os.chmod(str(path) + suffix, 0o600)
                except FileNotFoundError:
                    pass
        for name in ["prompt_tokens", "completion_tokens"]:
            if name not in {
                r[1] for r in self.db.execute("PRAGMA table_info(requests)")
            }:
                self.db.execute(
                    "ALTER TABLE requests ADD COLUMN "
                    + name
                    + " INTEGER NOT NULL DEFAULT 0"
                )
        self.dummy_password = password_hash(secrets.token_urlsafe(32))

        existing = {row[1] for row in self.db.execute("PRAGMA table_info(requests)")}
        for field in [
            "request_id",
            "client_request_id",
            "helix_turn_id",
            "helix_model_call_id",
            "upstream_response_id",
        ]:
            if field not in existing:
                self.db.execute("ALTER TABLE requests ADD COLUMN " + field + " TEXT")
        self.db.execute(
            "CREATE INDEX IF NOT EXISTS idx_requests_request_id ON requests(request_id)"
        )

    @contextmanager
    def transaction(self):
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield self.db
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def audit(self, db, actor, action, target):
        db.execute(
            "INSERT INTO audit(actor,action,target,ts) VALUES(?,?,?,?)",
            (actor, action, str(target), time.time()),
        )

    def public_user(self, row):
        return {
            **{
                k: row[k]
                for k in [
                    "id",
                    "username",
                    "role",
                    "enabled",
                    "rpm",
                    "daily_requests",
                    "concurrency",
                    "must_change",
                    "created",
                ]
            },
            "services": json.loads(row["services"]),
            "email": row["email"],
        }

    def create_user(
        self,
        username,
        password,
        role="user",
        services=None,
        rpm=30,
        daily_requests=1000,
        concurrency=2,
        must_change=True,
        actor=None,
        email=None,
    ):
        encoded = password_hash(password)
        with self.transaction() as db:
            try:
                cur = db.execute(
                    """INSERT INTO users(username,password,role,services,rpm,
                    daily_requests,concurrency,must_change,created,email) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                    (
                        username.lower(),
                        encoded,
                        role,
                        json.dumps(sorted(services or SERVICES)),
                        rpm,
                        daily_requests,
                        concurrency,
                        int(must_change),
                        time.time(),
                        email,
                    ),
                )
            except sqlite3.IntegrityError:
                raise Denied(409, "邮箱已注册，请登录" if email else "用户名已存在")
            self.audit(db, actor, "create_user", cur.lastrowid)
            return self.public_user(
                db.execute(
                    "SELECT * FROM users WHERE id=?", (cur.lastrowid,)
                ).fetchone()
            )

    def register(self, email, password, ip):
        now = time.time()
        with self.transaction() as db:
            db.execute("DELETE FROM registration_attempts WHERE ts<?", (now - 3600,))
            count = db.execute(
                "SELECT count(*) FROM registration_attempts WHERE ip_hash=?",
                (digest(ip),),
            ).fetchone()[0]
            total = db.execute("SELECT count(*) FROM registration_attempts").fetchone()[
                0
            ]
            if count >= 5 or total >= 100:
                raise Denied(429, "注册尝试过多，请一小时后重试")
            db.execute(
                "INSERT INTO registration_attempts VALUES(?,?)", (digest(ip), now)
            )
        email = email.strip().lower()
        defaults = self.registration_defaults()
        # Registration never accepts role, permissions or quota fields from callers.
        return self.create_user(
            email,
            password,
            email=email,
            role="user",
            services=SERVICES,
            must_change=False,
            **defaults,
        )

    def registration_defaults(self):
        with self.lock:
            return json.loads(
                self.db.execute(
                    "SELECT value FROM settings WHERE name='registration_defaults'"
                ).fetchone()[0]
            )

    def update_registration_defaults(self, actor, values):
        with self.transaction() as db:
            db.execute(
                "UPDATE settings SET value=? WHERE name='registration_defaults'",
                (json.dumps(values),),
            )
            self.audit(
                db, actor, "update_registration_defaults", "registration_defaults"
            )
        return self.registration_defaults()

    def login(self, username, password, ip):
        now = time.time()
        with self.transaction() as db:
            db.execute("DELETE FROM login_attempts WHERE ts<?", (now - 300,))
            attempts = db.execute(
                "SELECT count(*) FROM login_attempts WHERE ip=?", (ip,)
            ).fetchone()[0]
            if attempts >= 10:
                raise Denied(429, "登录尝试过多，请五分钟后重试")
            db.execute("INSERT INTO login_attempts VALUES(?,?)", (ip, now))
            row = db.execute(
                "SELECT * FROM users WHERE username=?", (username.lower(),)
            ).fetchone()
        valid = check_password(
            password, row["password"] if row else self.dummy_password
        )
        if not valid or row is None or not row["enabled"]:
            raise Denied(401, "用户名或密码错误")
        raw, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
        with self.transaction() as db:
            fresh = db.execute(
                "SELECT * FROM users WHERE id=?", (row["id"],)
            ).fetchone()
            if not fresh["enabled"] or fresh["password"] != row["password"]:
                raise Denied(401, "账号状态已变更，请重新登录")
            db.execute("DELETE FROM sessions WHERE expires<?", (now,))
            db.execute(
                "INSERT INTO sessions(hash,user_id,csrf,expires) VALUES(?,?,?,?)",
                (digest(raw), row["id"], csrf, now + 43200),
            )
            self.audit(db, row["id"], "login", row["id"])
        return raw, csrf, self.public_user(fresh)

    def session(self, raw):
        with self.lock:
            row = self.db.execute(
                """SELECT users.*,sessions.csrf FROM sessions JOIN users
               ON users.id=sessions.user_id WHERE sessions.hash=? AND expires>? AND enabled=1""",
                (digest(raw), time.time()),
            ).fetchone()
            if not row:
                raise Denied(401, "请重新登录")
            return self.public_user(row), row["csrf"]

    def _revoke_family(self, db, family):
        db.execute("UPDATE auth_families SET revoked=1 WHERE id=?", (family,))
        db.execute("DELETE FROM sessions WHERE family_id=?", (family,))

    def _new_tokens(self, db, family, expires):
        now = time.time()
        access = "ai-at-" + secrets.token_urlsafe(32)
        refresh = "ai-rt-" + secrets.token_urlsafe(32)
        access_expiry = min(now + 900, expires)
        db.execute(
            "INSERT INTO access_tokens VALUES(?,?,?)",
            (digest(access), family, access_expiry),
        )
        db.execute(
            "INSERT INTO refresh_tokens VALUES(?,?,?,0)",
            (digest(refresh), family, expires),
        )
        return {
            "token_type": "Bearer",
            "access_token": access,
            "expires_in": int(access_expiry - now),
            "refresh_token": refresh,
            "refresh_expires_in": max(0, int(expires - now)),
        }

    def issue_login_tokens(self, cookie):
        now = time.time()
        with self.transaction() as db:
            row = db.execute(
                "SELECT sessions.*,users.enabled FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires>?",
                (digest(cookie), now),
            ).fetchone()
            if not row or not row["enabled"]:
                raise Denied(401, "请重新登录")
            if row["family_id"]:
                raise Denied(401, "该登录会话已签发凭证，请重新登录")
            family = secrets.token_hex(24)
            expiry = now + 30 * 86400
            db.execute(
                "INSERT INTO auth_families VALUES(?,?,?,0)",
                (family, row["user_id"], expiry),
            )
            db.execute(
                "UPDATE sessions SET family_id=? WHERE hash=?", (family, digest(cookie))
            )
            return self._new_tokens(db, family, expiry)

    def _access_record(self, db, raw):
        row = db.execute(
            "SELECT users.*,auth_families.id AS family FROM access_tokens JOIN auth_families ON auth_families.id=access_tokens.family_id JOIN users ON users.id=auth_families.user_id WHERE access_tokens.hash=? AND access_tokens.expires>? AND auth_families.expires>? AND auth_families.revoked=0 AND users.enabled=1",
            (digest(raw), time.time(), time.time()),
        ).fetchone()
        if not row:
            raise Denied(401, "登录凭证无效或已过期，请刷新或重新登录")
        return row

    def access_user(self, raw):
        with self.lock:
            return self.public_user(self._access_record(self.db, raw))

    def refresh(self, raw):
        reused = False
        result = None
        with self.transaction() as db:
            row = db.execute(
                "SELECT refresh_tokens.*,auth_families.revoked,auth_families.expires AS family_expires,users.enabled FROM refresh_tokens JOIN auth_families ON auth_families.id=refresh_tokens.family_id JOIN users ON users.id=auth_families.user_id WHERE refresh_tokens.hash=?",
                (digest(raw),),
            ).fetchone()
            if (
                not row
                or row["revoked"]
                or row["expires"] <= time.time()
                or row["family_expires"] <= time.time()
                or not row["enabled"]
            ):
                raise Denied(401, "刷新凭证无效或已过期，请重新登录")
            if row["used"]:
                self._revoke_family(db, row["family_id"])
                reused = True
            else:
                db.execute(
                    "UPDATE refresh_tokens SET used=1 WHERE hash=?", (digest(raw),)
                )
                result = self._new_tokens(db, row["family_id"], row["family_expires"])
        # Commit replay revocation before raising, otherwise the transaction rolls it back.
        if reused:
            raise Denied(401, "刷新凭证已使用，该登录已撤销，请重新登录")
        return result

    def logout_access(self, raw):
        with self.transaction() as db:
            row = self._access_record(db, raw)
            self._revoke_family(db, row["family"])

    def logout_refresh(self, raw):
        with self.transaction() as db:
            row = db.execute(
                "SELECT family_id FROM refresh_tokens WHERE hash=?", (digest(raw),)
            ).fetchone()
            if row:
                self._revoke_family(db, row["family_id"])

    def logout(self, raw):
        with self.transaction() as db:
            row = db.execute(
                "SELECT family_id FROM sessions WHERE hash=?", (digest(raw),)
            ).fetchone()
            if row and row["family_id"]:
                self._revoke_family(db, row["family_id"])
            db.execute("DELETE FROM sessions WHERE hash=?", (digest(raw),))

    def change_password(self, uid, old, new):
        with self.lock:
            row = self.db.execute(
                "SELECT password FROM users WHERE id=?", (uid,)
            ).fetchone()
        if not check_password(old, row["password"]):
            raise Denied(403, "当前密码错误")
        encoded = password_hash(new)
        with self.transaction() as db:
            cur = db.execute(
                "UPDATE users SET password=?,must_change=0 WHERE id=? AND password=?",
                (encoded, uid, row["password"]),
            )
            if cur.rowcount != 1:
                raise Denied(409, "密码已变更，请重新登录")
            db.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
            db.execute("UPDATE auth_families SET revoked=1 WHERE user_id=?", (uid,))
            self.audit(db, uid, "change_password", uid)

    def users(self):
        with self.lock:
            return [
                self.public_user(r)
                for r in self.db.execute("SELECT * FROM users ORDER BY id")
            ]

    def update_user(self, actor, uid, changes):
        with self.transaction() as db:
            row = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            if not row:
                raise Denied(404, "账号不存在")
            if row["role"] == "admin" and changes.get("enabled") is False:
                n = db.execute(
                    "SELECT count(*) FROM users WHERE role='admin' AND enabled=1"
                ).fetchone()[0]
                if n <= 1:
                    raise Denied(409, "不能禁用最后一个管理员")
            for key, value in changes.items():
                if key not in {
                    "enabled",
                    "services",
                    "rpm",
                    "daily_requests",
                    "concurrency",
                }:
                    raise Denied(400, "不支持的账号字段")
                if key == "services":
                    value = json.dumps(sorted(value))
                db.execute(f"UPDATE users SET {key}=? WHERE id=?", (value, uid))
            if changes.get("enabled") is False:
                db.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
                db.execute("UPDATE auth_families SET revoked=1 WHERE user_id=?", (uid,))
            self.audit(db, actor, "update_user", uid)
        return next(u for u in self.users() if u["id"] == uid)

    def reset_password(self, actor, uid):
        raw = secrets.token_urlsafe(18)
        encoded = password_hash(raw)
        with self.transaction() as db:
            if not db.execute("SELECT id FROM users WHERE id=?", (uid,)).fetchone():
                raise Denied(404, "账号不存在")
            if uid == actor:
                raise Denied(400, "请使用修改本人密码接口")
            db.execute(
                "UPDATE users SET password=?,must_change=1 WHERE id=?", (encoded, uid)
            )
            db.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
            db.execute("UPDATE auth_families SET revoked=1 WHERE user_id=?", (uid,))
            db.execute("UPDATE keys SET revoked=1 WHERE user_id=?", (uid,))
            self.audit(db, actor, "reset_password_revoke_keys", uid)
        return raw

    def create_key(self, uid, name, services, days, actor=None):
        raw = "sk-acct-" + secrets.token_urlsafe(32)
        with self.transaction() as db:
            actor = uid if actor is None else actor
            manager = db.execute("SELECT * FROM users WHERE id=?", (actor,)).fetchone()
            if (
                not manager
                or manager["role"] != "admin"
                or not manager["enabled"]
                or manager["must_change"]
            ):
                raise Denied(403, "仅管理员可配置 API Key")
            user = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            if not user or not user["enabled"] or user["must_change"]:
                raise Denied(403, "请先修改初始密码或联系管理员")
            if not set(services).issubset(json.loads(user["services"])):
                raise Denied(403, "请求了账号没有的服务权限")
            cur = db.execute(
                """INSERT INTO keys(user_id,name,hash,prefix,services,expires,created)
                         VALUES(?,?,?,?,?,?,?)""",
                (
                    uid,
                    name,
                    digest(raw),
                    raw[:16],
                    json.dumps(sorted(services)),
                    time.time() + days * 86400,
                    time.time(),
                ),
            )
            self.audit(db, actor, "create_key", cur.lastrowid)
        return raw, cur.lastrowid

    def keys(self, uid):
        with self.lock:
            rows = self.db.execute(
                """SELECT id,name,prefix,services,expires,revoked,created
                                     FROM keys WHERE user_id=? ORDER BY id DESC""",
                (uid,),
            ).fetchall()
        return [{**dict(row), "services": json.loads(row["services"])} for row in rows]

    def revoke_key(self, actor, key_id, admin=False):
        with self.transaction() as db:
            manager = db.execute("SELECT * FROM users WHERE id=?", (actor,)).fetchone()
            if (
                not manager
                or manager["role"] != "admin"
                or not manager["enabled"]
                or manager["must_change"]
            ):
                raise Denied(403, "仅管理员可配置 API Key")
            row = db.execute("SELECT * FROM keys WHERE id=?", (key_id,)).fetchone()
            if not row:
                raise Denied(404, "密钥不存在")
            db.execute("UPDATE keys SET revoked=1 WHERE id=?", (key_id,))
            self.audit(db, actor, "revoke_key", key_id)

    def check_inference_auth(self, ip, limit=60, window=60):
        with self.lock:
            count = self.db.execute(
                "SELECT count(*) FROM inference_auth_failures WHERE ip_hash=? AND ts>?",
                (digest(ip), time.time() - window),
            ).fetchone()[0]
        if count >= limit:
            raise Denied(429, "该来源认证失败次数过多，请稍后重试")

    def record_inference_auth_failure(self, ip, window=60):
        with self.transaction() as db:
            now = time.time()
            db.execute(
                "DELETE FROM inference_auth_failures WHERE ts<=?", (now - window,)
            )
            db.execute(
                "INSERT INTO inference_auth_failures VALUES(?,?)", (digest(ip), now)
            )

    def acquire(self, raw, service, path):
        now = time.time()
        day = datetime.fromtimestamp(now, ZoneInfo("Asia/Shanghai")).date().isoformat()
        with self.transaction() as db:
            key_id = None
            auth_type = "access_token" if raw.startswith("ai-at-") else "api_key"
            if auth_type == "access_token":
                user = self._access_record(db, raw)
                permissions = json.loads(user["services"])
            else:
                key = db.execute(
                    "SELECT * FROM keys WHERE hash=?", (digest(raw),)
                ).fetchone()
                if not key or key["revoked"] or key["expires"] <= now:
                    raise Denied(401, "API Key 无效或已过期")
                user = db.execute(
                    "SELECT * FROM users WHERE id=?", (key["user_id"],)
                ).fetchone()
                key_id = key["id"]
                remaining = self._token_remaining(db, key_id, day)
                if remaining is not None and remaining <= 0:
                    raise Denied(429, "API Key 每日 token 额度已用尽")
                permissions = json.loads(key["services"])
            if not user["enabled"] or user["must_change"]:
                raise Denied(403, "账号已禁用或需要修改密码")
            if service not in permissions or service not in json.loads(
                user["services"]
            ):
                raise Denied(403, "没有该服务的权限")
            uid = user["id"]
            if (
                user["rpm"] > 0
                and db.execute(
                    "SELECT count(*) FROM requests WHERE user_id=? AND started>?",
                    (uid, now - 60),
                ).fetchone()[0]
                >= user["rpm"]
            ):
                raise Denied(429, "账号每分钟请求额度已用尽")
            if (
                user["daily_requests"] > 0
                and db.execute(
                    "SELECT count(*) FROM requests WHERE user_id=? AND day=?",
                    (uid, day),
                ).fetchone()[0]
                >= user["daily_requests"]
            ):
                raise Denied(429, "账号每日请求额度已用尽（北京时间零点重置）")
            # Defensive recovery if a streaming task was externally interrupted.
            db.execute(
                "UPDATE requests SET ended=?,status=504 WHERE ended IS NULL AND started<?",
                (now, now - 920),
            )
            if (
                db.execute(
                    "SELECT count(*) FROM requests WHERE user_id=? AND ended IS NULL",
                    (uid,),
                ).fetchone()[0]
                >= user["concurrency"]
            ):
                raise Denied(429, "账号并发额度已用尽")
            lease = secrets.token_hex(16)
            db.execute(
                """INSERT INTO requests(id,user_id,key_id,service,path,started,day,auth_type)
                        VALUES(?,?,?,?,?,?,?,?)""",
                (lease, uid, key_id, service, path, now, day, auth_type),
            )
        return lease

    def _token_remaining(self, db, key_id, day):
        row = db.execute(
            "SELECT legacy_daily_tokens FROM keys WHERE id=?", (key_id,)
        ).fetchone()
        if not row or row[0] <= 0:
            return None
        spent = db.execute(
            "SELECT coalesce(sum(prompt_tokens+completion_tokens),0) FROM requests WHERE key_id=? AND day=?",
            (key_id, day),
        ).fetchone()[0]
        baseline = db.execute(
            "SELECT prompt_tokens+completion_tokens FROM legacy_token_baseline WHERE key_id=? AND day=?",
            (key_id, day),
        ).fetchone()
        return max(0, row[0] - spent - (baseline[0] if baseline else 0))

    def token_remaining(self, lease):
        with self.lock:
            row = self.db.execute(
                "SELECT key_id,day FROM requests WHERE id=?", (lease,)
            ).fetchone()
            return (
                self._token_remaining(self.db, row["key_id"], row["day"])
                if row and row["key_id"]
                else None
            )

    def finish(
        self, lease, status, size=0, prompt_tokens=0, completion_tokens=0, trace=None
    ):
        with self.lock:
            self.db.execute(
                "UPDATE requests SET ended=?,status=?,response_bytes=?,prompt_tokens=?,completion_tokens=?,request_id=?,client_request_id=?,helix_turn_id=?,helix_model_call_id=?,upstream_response_id=? WHERE id=? AND ended IS NULL",
                (
                    time.time(),
                    status,
                    size,
                    max(0, prompt_tokens),
                    max(0, completion_tokens),
                    *(
                        (trace or {}).get(k)
                        for k in (
                            "request_id",
                            "client_request_id",
                            "helix_turn_id",
                            "helix_model_call_id",
                            "upstream_response_id",
                        )
                    ),
                    lease,
                ),
            )

    def usage(self, uid=None):
        with self.lock:
            where, params = ("WHERE user_id=?", (uid,)) if uid else ("", ())
            rows = self.db.execute(
                f"""SELECT id,user_id,service,auth_type,path,started,ended,status,response_bytes,prompt_tokens,completion_tokens,request_id,client_request_id,helix_turn_id,helix_model_call_id,upstream_response_id
                                   FROM requests {where} ORDER BY started DESC LIMIT 100""",
                params,
            ).fetchall()
            day = datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()
            totals = self.db.execute(
                """SELECT service,count(*) requests,coalesce(sum(response_bytes),0) response_bytes
                        FROM requests WHERE day=? """
                + ("AND user_id=? " if uid else "")
                + "GROUP BY service",
                (day, uid) if uid else (day,),
            ).fetchall()
        return {
            "today": day,
            "totals": [dict(r) for r in totals],
            "requests": [dict(r) for r in rows],
        }
