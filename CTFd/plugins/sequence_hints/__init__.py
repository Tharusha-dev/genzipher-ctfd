import json
import logging
from datetime import datetime, timezone

import requests
from flask import Blueprint, render_template, request, redirect, url_for, flash

from CTFd.models import db, Solves, Teams, Users, Challenges
from CTFd.utils.decorators import admins_only
from CTFd.utils import get_config, set_config

from sqlalchemy import event
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, object_session

import threading
from flask import current_app


logger = logging.getLogger(__name__)

PLUGIN_NAME = "sequence_hints"

PLUGIN_APP = None


CFG_ENABLED = "sequence_hints:enabled"
CFG_WEBHOOK_URL = "sequence_hints:webhook_url"
CFG_SHARED_SECRET = "sequence_hints:shared_secret"

class SequenceHintsProcessed(db.Model):
    __tablename__ = "sequence_hints_processed"
    id = db.Column(db.Integer, primary_key=True)
    solve_id = db.Column(db.Integer, unique=True, index=True, nullable=False)
    processed_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

def _bool(v, default=False):
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")

def _now_iso():
    return datetime.now(timezone.utc).isoformat()

def _get_team_members(team_id):
    if not team_id:
        return []
    members = Users.query.filter_by(team_id=team_id).all()
    out = []
    for u in members:
        out.append({
            "id": u.id,
            "name": getattr(u, "name", "") or getattr(u, "username", ""),
            "email": getattr(u, "email", "") or "",
        })
    return out

def _safe_name(u):
    return getattr(u, "name", "") or getattr(u, "username", "") or f"user-{u.id}"

# def _post_to_apps_script(payload: dict):
#     url = get_config(CFG_WEBHOOK_URL)
#     secret = get_config(CFG_SHARED_SECRET)

#     if not url or not secret:
#         logger.warning("[sequence_hints] Missing webhook_url/shared_secret; not sending")
#         return

#     payload = dict(payload)
#     payload["secret"] = secret

#     try:
#         # Apps Script can be slow; keep timeout reasonable
#         r = requests.post(url, json=payload, timeout=8)
#         logger.warning("[sequence_hints] webhook status=%s body=%s", r.status_code, r.text[:200])
#         if r.status_code >= 400:
#             logger.warning("[sequence_hints] Webhook error %s: %s", r.status_code, r.text[:300])
#     except Exception as e:
#         logger.exception("[sequence_hints] Failed POST to Apps Script: %s", e)

def _post_to_apps_script(payload: dict):
    url = get_config(CFG_WEBHOOK_URL)
    secret = get_config(CFG_SHARED_SECRET)

    logger.error("[sequence_hints] posting to url=%r", url)

    payload = dict(payload)
    payload["secret"] = secret

    try:
        r = requests.post(url, json=payload, timeout=15)
        logger.error("[sequence_hints] webhook status=%s body=%s", r.status_code, r.text[:300])
    except Exception as e:
        logger.exception("[sequence_hints] Failed POST to Apps Script: %s", e)


def _mark_processed(solve_id: int) -> bool:
    """
    Returns True if this solve_id is newly marked processed.
    False means it was already processed (dedupe).
    """
    try:
        db.session.add(SequenceHintsProcessed(solve_id=solve_id))
        db.session.commit()
        return True
    except IntegrityError:
        db.session.rollback()
        return False

def _process_solve_id(solve_id: int):
    # ---- DEBUG: show config every time ----
    enabled_raw = get_config(CFG_ENABLED)
    url = get_config(CFG_WEBHOOK_URL)
    secret = get_config(CFG_SHARED_SECRET)

    logger.error(
        "[sequence_hints] solve_id=%s enabled_raw=%r url_set=%s secret_len=%s",
        solve_id,
        enabled_raw,
        bool(url),
        len(secret) if secret else 0,
    )

    if not _bool(enabled_raw, default=False):
        logger.error("[sequence_hints] disabled -> returning")
        return

    if not url:
        logger.error("[sequence_hints] missing webhook_url -> returning")
        return

    if not secret:
        logger.error("[sequence_hints] missing shared_secret -> returning")
        return
    # ---- END DEBUG ----

    if not _mark_processed(solve_id):
        logger.error("[sequence_hints] solve_id=%s already processed (dedupe) -> returning", solve_id)
        return

    solve = Solves.query.get(solve_id)
    if not solve:
        logger.error("[sequence_hints] solve_id=%s not found in Solves -> returning", solve_id)
        return

    user = Users.query.get(solve.user_id) if solve.user_id else None
    if not user:
        logger.error("[sequence_hints] solve_id=%s user not found -> returning", solve_id)
        return

    # NOTE: don't skip admins for now; comment this out temporarily
    # if getattr(user, "type", "") == "admin":
    #     logger.error("[sequence_hints] solve by admin -> returning")
    #     return

    team = Teams.query.get(solve.team_id) if solve.team_id else None

    # If CTFd is in user-mode (no teams), treat user as "team"
    account_id = team.id if team else user.id if user else None
    account_name = team.name if team else _safe_name(user) if user else "unknown"

    if not account_id:
        return

    # Count solves for this team/user
    if team:
        team_solve_count = Solves.query.filter_by(team_id=team.id).count()
        members = _get_team_members(team.id)
    else:
        team_solve_count = Solves.query.filter_by(user_id=user.id).count()
        members = [{
            "id": user.id,
            "name": _safe_name(user),
            "email": getattr(user, "email", "") or "",
        }]

    chal = Challenges.query.get(solve.challenge_id) if solve.challenge_id else None

    payload = {
        "event": "solve",
        "solve_id": solve.id,
        "timestamp": _now_iso(),
        "team": {"id": str(account_id), "name": account_name},
        "user": {
            "id": str(user.id) if user else "",
            "name": _safe_name(user) if user else "",
            "email": getattr(user, "email", "") or "" if user else "",
        },
        "challenge": {
            "id": str(chal.id) if chal else str(solve.challenge_id),
            "name": chal.name if chal else "",
            "category": getattr(chal, "category", "") if chal else "",
            "value": getattr(chal, "value", 0) if chal else 0,
        },
        "team_members": members,
        "team_solve_count": team_solve_count,
    }

    _post_to_apps_script(payload)

# Queue solve_ids on insert; send after commit
@event.listens_for(Solves, "after_insert")
def _solves_after_insert(mapper, connection, target):
    sess = object_session(target)
    if sess is None:
        return
    pending = sess.info.setdefault("sequence_hints_pending_solves", [])
    pending.append(target.id)

# @event.listens_for(Session, "after_commit")
# def _session_after_commit(session):
#     pending = session.info.pop("sequence_hints_pending_solves", [])
#     for solve_id in pending:
#         try:
#             _process_solve_id(int(solve_id))
#         except Exception:
#             logger.exception("[sequence_hints] Failed processing solve_id=%s", solve_id)
# @event.listens_for(Session, "after_commit")
# def _session_after_commit(session):
#     pending = session.info.pop("sequence_hints_pending_solves", [])
#     if not pending:
#         return

#     # IMPORTANT: don't query the DB inside after_commit.
#     # Run the work after the commit finishes, using a new context.
#     try:
#         app = current_app._get_current_object()
#     except Exception:
#         logger.warning("[sequence_hints] No current_app; skipping pending solves")
#         return

#     def worker(ids):
#         with app.app_context():
#             for solve_id in ids:
#                 try:
#                     _process_solve_id(int(solve_id))
#                 except Exception:
#                     logger.exception("[sequence_hints] Failed processing solve_id=%s", solve_id)

#     threading.Thread(target=worker, args=(list(pending),), daemon=True).start()

@event.listens_for(Session, "after_commit")
def _session_after_commit(session):
    pending = session.info.pop("sequence_hints_pending_solves", [])
    if not pending:
        return

    app = PLUGIN_APP
    if app is None:
        # Use error so it shows in Docker logs even if loglevel is high
        logger.error("[sequence_hints] PLUGIN_APP is None; load(app) may not have run")
        return

    def worker(ids):
        with app.app_context():
            # ensure this thread has a clean session
            try:
                db.session.remove()
            except Exception:
                pass

            for solve_id in ids:
                try:
                    logger.error("[sequence_hints] processing solve_id=%s", solve_id)  # TEMP debug
                    _process_solve_id(int(solve_id))
                except Exception:
                    logger.exception("[sequence_hints] Failed processing solve_id=%s", solve_id)

    threading.Thread(target=worker, args=(list(pending),), daemon=True).start()


@event.listens_for(Session, "after_rollback")
def _session_after_rollback(session):
    session.info.pop("sequence_hints_pending_solves", None)

def load(app):
    # Ensure our table exists
    global PLUGIN_APP
    PLUGIN_APP = app

    with app.app_context():
        db.create_all()

    bp = Blueprint(
        "sequence_hints",
        __name__,
        template_folder="templates",
        static_folder="assets",
        url_prefix="/admin/sequence_hints",
    )

    @bp.route("", methods=["GET", "POST"])
    @bp.route("/", methods=["GET", "POST"])
    @admins_only
    def config():
        if request.method == "POST":
            enabled = request.form.get("enabled", "false")
            webhook_url = request.form.get("webhook_url", "").strip()
            shared_secret = request.form.get("shared_secret", "").strip()

            set_config(CFG_ENABLED, enabled)
            set_config(CFG_WEBHOOK_URL, webhook_url)
            set_config(CFG_SHARED_SECRET, shared_secret)

            flash("Sequence Hints settings saved.", "success")
            return redirect(url_for("sequence_hints.config"))

        return render_template(
            "sequence_hints_config.html",
            enabled=_bool(get_config(CFG_ENABLED), default=False),
            webhook_url=get_config(CFG_WEBHOOK_URL),
            shared_secret=get_config(CFG_SHARED_SECRET),
        )

    app.register_blueprint(bp)
