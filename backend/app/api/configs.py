"""Config CRUD: list / get / save / delete."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from ..dependencies import get_config_service, get_request_id
from ..schemas import ConfigSchema
from ..services.config_service import ConfigExists, ConfigNotFound, ConfigService

router = APIRouter(prefix="/api/configs", tags=["configs"])


@router.get("")
def list_configs(svc: ConfigService = Depends(get_config_service)) -> dict:
    return {"configs": svc.list()}


@router.get("/{name}")
def get_config(name: str, svc: ConfigService = Depends(get_config_service)) -> ConfigSchema:
    try:
        return svc.get(name)
    except ConfigNotFound:
        raise HTTPException(status_code=404, detail=f"找不到專案『{name}』")


@router.post("")
def save_config(
    config: ConfigSchema,
    overwrite: bool = Query(default=False),
    svc: ConfigService = Depends(get_config_service),
    request_id: str = Depends(get_request_id),
) -> dict:
    try:
        svc.save(config, overwrite=overwrite)
    except ConfigExists:
        raise HTTPException(
            status_code=409,
            detail={
                "error": f"專案『{config.name}』已存在，是否覆蓋？",
                "code": "ConfigExists",
                "name": config.name,
                "request_id": request_id,
            },
        )
    return {"name": config.name, "request_id": request_id}


@router.delete("/{name}", status_code=204)
def delete_config(name: str, svc: ConfigService = Depends(get_config_service)) -> Response:
    svc.delete(name)
    return Response(status_code=204)
