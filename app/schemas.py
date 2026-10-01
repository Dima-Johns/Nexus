from pydantic import BaseModel, Field


class LoginIn(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    id: int
    username: str
    full_name: str
    role: str
    is_active: bool
    org_id: int | None = None
    org_name: str = ""
    idle_timeout_minutes: int = 30
    permissions: list[str] = Field(default_factory=list)

    class Config:
        from_attributes = True


class UserCreate(BaseModel):
    username: str
    password: str
    full_name: str
    role: str = "dispatcher"
    is_active: bool = True
    org_id: int | None = None
    idle_timeout_minutes: int = 30
    permissions: list[str] = Field(default_factory=list)


class UserUpdate(BaseModel):
    full_name: str | None = None
    password: str | None = None
    role: str | None = None
    is_active: bool | None = None
    org_id: int | None = None
    idle_timeout_minutes: int | None = None
    permissions: list[str] | None = None


class MeUpdate(BaseModel):
    idle_timeout_minutes: int | None = None
    org_id: int | None = None
    username: str | None = None
    full_name: str | None = None
    current_password: str | None = None
    password: str | None = None


class OrgIn(BaseModel):
    name: str
    code: str = ""
    is_active: bool = True


class OrgOut(BaseModel):
    id: int
    name: str
    code: str = ""
    is_active: bool = True
    user_count: int = 0

    class Config:
        from_attributes = True


class PermissionsCatalogOut(BaseModel):
    permissions: list[dict]


class UserPermissionsIn(BaseModel):
    permissions: list[str] = Field(default_factory=list)


class ClientIn(BaseModel):
    name: str
    phone: str = ""
    company: str = ""
    address: str = ""
    notes: str = ""


class ClientOut(ClientIn):
    id: int

    class Config:
        from_attributes = True


class AgentIn(BaseModel):
    name: str
    code: str
    phone: str = ""
    region: str = ""
    commission_pct: float = 5.0
    is_active: bool = True


class AgentOut(AgentIn):
    id: int
    driver_count: int = 0
    code_locked: bool = False

    class Config:
        from_attributes = True


class AgentCodeIn(BaseModel):
    code: str


class WarehouseIn(BaseModel):
    name: str
    address: str = ""
    lat: float
    lng: float
    is_default: bool = False
    is_active: bool = True


class WarehouseOut(WarehouseIn):
    id: int

    class Config:
        from_attributes = True


class DriverIn(BaseModel):
    name: str
    phone: str = ""
    vehicle_plate: str = ""
    vehicle_type: str = "furgon"
    status: str = "idle"
    agent_id: int | None = None
    is_active: bool = True


class DriverAgentIn(BaseModel):
    agent_id: int | None = None


class DriverOut(BaseModel):
    id: int
    name: str
    phone: str
    vehicle_plate: str
    vehicle_type: str
    status: str
    lat: float
    lng: float
    heading: float
    agent_id: int | None
    agent_name: str | None = None
    agent_code: str = ""
    is_active: bool
    username: str = ""
    has_password: bool = False
    online: bool = False
    seen_at: str | None = None

    class Config:
        from_attributes = True


class DriverAccessOut(BaseModel):
    id: int
    name: str
    username: str
    password: str | None = None
    qr_payload: str
    qr_svg: str = ""
    has_password: bool = False


class DriverAccessIn(BaseModel):
    reset_password: bool = False
    reset_qr: bool = False


class DriverQrIn(BaseModel):
    token: str


class GpsPointIn(BaseModel):
    lat: float
    lng: float
    heading: float = 0
    accuracy: float = 0
    speed: float = 0
    recorded_at: str | None = None
    offline: bool = False


class GpsBatchIn(BaseModel):
    points: list[GpsPointIn] = Field(default_factory=list)


class DriverOrderStatusIn(BaseModel):
    status: str


class DriverStartIn(BaseModel):
    route_code: str = ""
    delivery_date: str = ""


class DriverReplanIn(DriverStartIn):
    lat: float | None = None
    lng: float | None = None
    first_id: int | None = None


class OrderIn(BaseModel):
    client_id: int | None = None
    driver_id: int | None = None
    pickup_address: str
    dropoff_address: str
    pickup_lat: float = 41.3111
    pickup_lng: float = 69.2797
    dropoff_lat: float = 41.3275
    dropoff_lng: float = 69.2283
    cargo: str = ""
    weight_kg: float = 0
    amount: float = 0
    route_code: str = ""
    sales_rep: str = ""
    agent_code: str = ""
    status: str = "new"
    eta_minutes: int = 30


class BulkStatusIn(BaseModel):
    ids: list[int]
    status: str = "assigned"


class BulkIdsIn(BaseModel):
    ids: list[int]


class BulkDateIn(BaseModel):
    ids: list[int]
    delivery_date: str


class BulkAssignIn(BaseModel):
    ids: list[int]
    driver_id: int


class RouteRenameIn(BaseModel):
    route_code: str
    delivery_date: str = ""
    new_name: str
    driver_id: int | None = None


class DayPlanIn(BaseModel):
    plan_date: str = ""
    name: str


class DayPlanOut(BaseModel):
    plan_date: str
    name: str
    count: int = 0
    km: float = 0


class PlanIn(BaseModel):
    ids: list[int] = Field(default_factory=list)
    driver_ids: list[int]
    delivery_date: str
    window_start: str = "09:00"
    window_end: str = "18:00"


class OrderOut(BaseModel):
    id: int
    code: str
    client_id: int | None
    client_name: str | None = None
    driver_id: int | None
    driver_name: str | None = None
    pickup_address: str
    dropoff_address: str
    pickup_lat: float
    pickup_lng: float
    dropoff_lat: float
    dropoff_lng: float
    cargo: str = ""
    weight_kg: float = 0
    amount: float = 0
    route_code: str = ""
    sales_rep: str = ""
    agent_code: str = ""
    delivery_date: str = ""
    window_start: str = ""
    window_end: str = ""
    extra_json: str | None = None
    stop_no: int = 0
    status: str = "new"
    eta_minutes: int
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    warehouse_lat: float | None = None
    warehouse_lng: float | None = None
    proof_reason: str = ""
    proof_photo: str = ""
    proof_at: str | None = None

    class Config:
        from_attributes = True


class TemplateIn(BaseModel):
    name: str
    entity: str = "orders"
    description: str = ""
    sheet: str | None = "Sheet1"
    header_row: int = 1
    mapping: dict[str, str] = Field(default_factory=dict)
    status: str | None = None


class TemplateReviewIn(BaseModel):
    note: str = ""


class TemplateOut(BaseModel):
    id: int
    name: str
    entity: str
    description: str
    mapping_json: str
    status: str
    submitted_by: str
    reviewed_by: str | None
    review_note: str
    created_at: str | None = None
    sheet: str | None = None
    header_row: int = 1
    mapping: dict[str, str] = Field(default_factory=dict)

    class Config:
        from_attributes = True
