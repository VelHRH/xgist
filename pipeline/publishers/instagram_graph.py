"""Instagram Graph API publisher — stub for future expansion.

To activate later: convert the IG account to Business/Creator, create a Meta
app, obtain a long-lived page token, then implement the two-step container
flow (POST /{ig-user-id}/media, then /{ig-user-id}/media_publish). Media must
be reachable at a public URL at publish time.
"""

from .base import Publisher


class InstagramGraphPublisher(Publisher):
    def publish(self, user_cfg: dict, caption: str, media_paths: list[str]) -> str:
        raise NotImplementedError(
            "Instagram publishing is not configured yet — see this module's "
            "docstring for the activation steps."
        )
