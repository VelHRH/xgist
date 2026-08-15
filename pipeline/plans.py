from datetime import datetime


FREE_HOURS = 1
FREE_SOURCES = 5
PRO_HOURS = 6
PRO_SOURCES = 25
FREE_THREAD_POSTS = 1
PRO_THREAD_POSTS = 5


def resolve_plan(uid: str, cfg: dict, whitelist: list, promo: list,
                 admin_id: str, now: datetime) -> dict:
    usage = {
        "sources": len(cfg.get("sources") or []),
        "hours": len(cfg.get("hours") or []),
    }
    expires_at = cfg.get("paid_until")
    try:
        active = bool(expires_at and datetime.fromisoformat(expires_at) > now)
    except (TypeError, ValueError):
        active = False
    if uid == admin_id:
        source = "administrator"
    elif active and cfg.get("pro_source") == "paid":
        source = "paid"
    elif uid in whitelist:
        source = "courtesy"
    elif active:
        source = "trial" if (cfg.get("pro_source") == "trial" or
                             not cfg.get("pro_source") and uid in promo) else "paid"
    else:
        source = "free"
    pro = source != "free"
    return {
        "tier": "pro" if pro else "free",
        "source": source,
        "expires_at": expires_at if source in {"paid", "trial"} else None,
        "limits": {
            "sources": PRO_SOURCES if pro else FREE_SOURCES,
            "hours": PRO_HOURS if pro else FREE_HOURS,
            "thread_posts": PRO_THREAD_POSTS if pro else FREE_THREAD_POSTS,
        },
        "usage": usage,
    }


def apply_plan(cfg: dict, plan: dict) -> dict:
    applied = dict(cfg)
    applied["_plan"] = plan
    applied["hours"] = (cfg.get("hours") or [9])[:plan["limits"]["hours"]]
    applied["sources"] = (cfg.get("sources") or [])[:plan["limits"]["sources"]]
    return applied
