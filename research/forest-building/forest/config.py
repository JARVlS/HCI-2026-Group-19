"""Load config/default.yaml and derive typed parameter objects from it."""
from __future__ import annotations

import copy
import random
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any

import numpy as np
import yaml

from . import ROOT

DEFAULT = ROOT / "config" / "default.yaml"


def load(path: Path | str = DEFAULT) -> dict[str, Any]:
    """The config as a nested dict, with every path made absolute."""
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    cfg["paths"] = {k: str((ROOT / v).resolve()) for k, v in cfg["paths"].items()}
    return cfg


def with_overrides(cfg: dict[str, Any], **sections: dict[str, Any]) -> dict[str, Any]:
    """A deep copy of `cfg` with single values replaced, e.g. with_overrides(cfg, ip={"mu": 0})."""
    out = copy.deepcopy(cfg)
    for section, values in sections.items():
        out[section].update(values)
    return out


def seed_everything(cfg: dict[str, Any]) -> None:
    random.seed(cfg["seed"])
    np.random.seed(cfg["seed"])


@dataclass(frozen=True)
class IPParams:
    """The IP's limits and weights (plan §2.2)."""
    L: int = 2
    U: int = 6
    B: int = 5
    D: int = 3
    K_T: int = 4
    K_G: int = 5
    alpha: float = 0.5
    alpha_G: float = 0.5
    lam: float = 0.4
    lam_G: float = 1.0
    beta: float = 0.3
    mu: float = 0.3
    nu: float = 0.5
    rho: float = 0.15
    F: float = 0.5
    tau: float = 0.2
    use_renames: bool = True
    max_alternatives_per_old_prompt: int = 4
    max_parents_per_topic: int = 4
    time_limit_s: float = 10
    mip_gap: float = 0.0
    size_limited: bool = True
    max_vars: int = 2000
    max_constrs: int = 2000
    output_flag: int = 0

    @classmethod
    def from_config(cls, cfg: dict[str, Any], **overrides: Any) -> "IPParams":
        names = {f.name for f in fields(cls)}
        values = {k: v for k, v in cfg["ip"].items() if k in names}
        values.update({k: v for k, v in cfg["gurobi"].items() if k in names})
        values.update(overrides)
        return cls(**values)

    def replace(self, **changes: Any) -> "IPParams":
        values = {f.name: getattr(self, f.name) for f in fields(self)}
        values.update(changes)
        return IPParams(**values)
