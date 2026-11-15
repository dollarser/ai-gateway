"""Shared HTTP denial type, independent of local account persistence."""


class Denied(Exception):
    def __init__(self, status, detail):
        self.status, self.detail = status, detail
        super().__init__(detail)
