from typing import Annotated

from pydantic import BaseModel, Field, field_validator, model_validator

# Kiruvchi matn/son chegaralari: bazadagi ustun uzunligidan oshmaydi, katta so‘rov serverni og‘irlashtirmaydi
Login = Annotated[str, Field(max_length=80)]
Password = Annotated[str, Field(max_length=128)]
Name = Annotated[str, Field(max_length=160)]
Title = Annotated[str, Field(max_length=255)]
Address = Annotated[str, Field(max_length=500)]
Note = Annotated[str, Field(max_length=2000)]
Phone = Annotated[str, Field(max_length=40)]
Code = Annotated[str, Field(max_length=80)]
Short = Annotated[str, Field(max_length=32)]
AgentCode = Annotated[str, Field(max_length=2)]
DateStr = Annotated[str, Field(max_length=40)]
TimeStr = Annotated[str, Field(max_length=8)]
Lat = Annotated[float, Field(ge=-90, le=90)]
Lng = Annotated[float, Field(ge=-180, le=180)]
Ids = Annotated[list[int], Field(max_length=20000)]
PermList = Annotated[list[str], Field(max_length=200)]


def _strip_nul(v):
    if isinstance(v, str):
        return v.replace("\x00", "")
    if isinstance(v, dict):
        return {k: _strip_nul(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_strip_nul(x) for x in v]
    return v


class Schema(BaseModel):
    # PostgreSQL matnda NUL belgisini qabul qilmaydi — so‘rov 500 xato bilan yiqilmasin
    @model_validator(mode="before")
    @classmethod
    def _no_nul(cls, data):
        return _strip_nul(data) if isinstance(data, dict) else data


class LoginIn(Schema):
    username: Login
    password: Password
    org_code: Short = ""


class UserOut(Schema):
    id: int
    username: str
    full_name: str
    role: str
    is_active: bool
    org_id: int | None = None
    org_name: str = ""
    org_code: str = ""
    idle_timeout_minutes: int = 30
    permissions: list[str] = Field(default_factory=list)

    class Config:
        from_attributes = True


class UserCreate(Schema):
    username: Login
    password: Password
    full_name: Name
    role: Short = "dispatcher"
    is_active: bool = True
    org_id: int | None = None
    idle_timeout_minutes: Annotated[int, Field(ge=0, le=1440)] = 30
    permissions: PermList = Field(default_factory=list)


class UserUpdate(Schema):
    username: Login | None = None
    full_name: Name | None = None
    password: Password | None = None
    role: Short | None = None
    is_active: bool | None = None
    org_id: int | None = None
    idle_timeout_minutes: Annotated[int, Field(ge=0, le=1440)] | None = None
    permissions: PermList | None = None


class MeUpdate(Schema):
    idle_timeout_minutes: Annotated[int, Field(ge=0, le=1440)] | None = None
    org_id: int | None = None
    username: Login | None = None
    full_name: Name | None = None
    current_password: Password | None = None
    password: Password | None = None


class OrgIn(Schema):
    name: Name
    address: Annotated[str, Field(max_length=300)] = ""
    lat: Lat | None = None
    lng: Lng | None = None
    admin_username: Login = ""
    admin_password: Password = ""
    admin_full_name: Name = ""


class OrgUpdate(Schema):
    name: Name | None = None
    is_active: bool | None = None
    address: Annotated[str, Field(max_length=300)] | None = None
    lat: Lat | None = None
    lng: Lng | None = None


class OrgUserIn(Schema):
    username: Login
    password: Password
    full_name: Name = ""
    role: Short = "dispatcher"


class OrgUserUpdate(Schema):
    password: Password | None = None
    is_active: bool | None = None


class OrgOut(Schema):
    id: int
    name: str
    code: str = ""
    is_active: bool = True
    address: str = ""
    lat: float | None = None
    lng: float | None = None
    user_count: int = 0
    admin_count: int = 0
    dispatcher_count: int = 0
    driver_count: int = 0
    is_own: bool = False
    created_at: str | None = None

    class Config:
        from_attributes = True


class PermissionsCatalogOut(Schema):
    permissions: list[dict]


class UserPermissionsIn(Schema):
    permissions: PermList = Field(default_factory=list)


class ClientIn(Schema):
    name: Title
    phone: Phone = ""
    company: Title = ""
    address: Address = ""
    notes: Note = ""


class ClientOut(ClientIn):
    id: int

    class Config:
        from_attributes = True


class ClientUpdate(Schema):
    name: Title | None = None
    code: Code | None = None
    phone: Phone | None = None
    address: Address | None = None
    lat: Lat | None = None
    lng: Lng | None = None
    sales_rep: Name | None = None
    agent_code: Annotated[str, Field(max_length=10)] | None = None
    notes: Note | None = None


class ClientBaseOut(Schema):
    id: int
    org_id: int | None = None
    org_name: str = ""
    code: str = ""
    name: str
    phone: str = ""
    address: str = ""
    lat: float = 0
    lng: float = 0
    sales_rep: str = ""
    agent_code: str = ""
    source: str = "manual"
    notes: str = ""
    orders_count: int = 0
    last_order_date: str = ""
    created_at: str | None = None


class AgentIn(Schema):
    name: Name
    code: Annotated[str, Field(max_length=10)]
    phone: Phone = ""
    region: Annotated[str, Field(max_length=120)] = ""
    commission_pct: Annotated[float, Field(ge=0, le=100)] = 5.0
    is_active: bool = True


class AgentOut(AgentIn):
    id: int
    driver_count: int = 0
    code_locked: bool = False

    class Config:
        from_attributes = True


class AgentCodeIn(Schema):
    code: Annotated[str, Field(max_length=10)]


class WarehouseIn(Schema):
    name: Name
    address: Address = ""
    lat: Lat
    lng: Lng
    is_default: bool = False
    is_active: bool = True


class WarehouseOut(WarehouseIn):
    id: int

    class Config:
        from_attributes = True


class DriverIn(Schema):
    name: Name
    phone: Phone = ""
    vehicle_plate: Short = ""
    vehicle_type: Annotated[str, Field(max_length=64)] = "furgon"
    status: Short = "idle"
    agent_id: int | None = None
    is_active: bool = True


class DriverAgentIn(Schema):
    agent_id: int | None = None


class DriverOut(Schema):
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


class DriverAccessOut(Schema):
    id: int
    name: str
    username: str
    password: str | None = None
    qr_payload: str
    qr_svg: str = ""
    has_password: bool = False


class DriverAccessIn(Schema):
    reset_password: bool = False
    reset_qr: bool = False


class DriverQrIn(Schema):
    token: Annotated[str, Field(max_length=128)]


class GpsPointIn(Schema):
    lat: Lat
    lng: Lng
    heading: float = 0
    accuracy: float = 0
    speed: float = 0
    recorded_at: DateStr | None = None
    offline: bool = False


GPS_BATCH_MAX = 20000


def _valid_gps_point(p) -> bool:
    if not isinstance(p, dict):
        return False
    try:
        lat, lng = float(p.get("lat")), float(p.get("lng"))
    except (TypeError, ValueError):
        return False
    recorded = p.get("recorded_at")
    return -90 <= lat <= 90 and -180 <= lng <= 180 and (recorded is None or len(str(recorded)) <= 40)


class GpsBatchIn(Schema):
    points: list[GpsPointIn] = Field(default_factory=list)

    @field_validator("points", mode="before")
    @classmethod
    def _latest_valid(cls, v):
        # Oflayn kesh rad etilsa ilova uni hech qachon tozalay olmaydi: yaroqsizini tashlab, eng yangilarini olamiz
        if not isinstance(v, list):
            return v
        return [p for p in v if _valid_gps_point(p)][-GPS_BATCH_MAX:]


class DriverOrderStatusIn(Schema):
    status: Short


class DriverStartIn(Schema):
    route_code: Code = ""
    delivery_date: DateStr = ""


class DriverReorderIn(DriverStartIn):
    order_ids: Ids = []


class DriverReplanIn(DriverStartIn):
    lat: Lat | None = None
    lng: Lng | None = None
    first_id: int | None = None


class OrderIn(Schema):
    client_id: int | None = None
    driver_id: int | None = None
    pickup_address: Address
    dropoff_address: Address
    pickup_lat: Lat = 41.3111
    pickup_lng: Lng = 69.2797
    dropoff_lat: Lat = 41.3275
    dropoff_lng: Lng = 69.2283
    cargo: Title = ""
    weight_kg: Annotated[float, Field(ge=0, le=1_000_000)] = 0
    amount: Annotated[float, Field(ge=0, le=1_000_000_000_000)] = 0
    route_code: Code = ""
    sales_rep: Name = ""
    agent_code: AgentCode = ""
    status: Short = "new"
    eta_minutes: Annotated[int, Field(ge=0, le=100_000)] = 30


class BulkStatusIn(Schema):
    ids: Ids
    status: Short = "assigned"


class BulkIdsIn(Schema):
    ids: Ids


class BulkDateIn(Schema):
    ids: Ids
    delivery_date: DateStr


class BulkAssignIn(Schema):
    ids: Ids
    driver_id: int


class RouteRenameIn(Schema):
    route_code: Code
    delivery_date: DateStr = ""
    new_name: Code
    driver_id: int | None = None


class DayPlanIn(Schema):
    plan_date: DateStr = ""
    name: Name


class DayPlanOut(Schema):
    plan_date: str
    name: str
    count: int = 0
    km: float = 0


class PlanIn(Schema):
    ids: Ids = Field(default_factory=list)
    driver_ids: Annotated[list[int], Field(max_length=1000)]
    delivery_date: DateStr
    window_start: TimeStr = "09:00"
    window_end: TimeStr = "18:00"


class OrderOut(Schema):
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
    proof_comment: str = ""
    proof_at: str | None = None

    class Config:
        from_attributes = True


class TemplateIn(Schema):
    name: Name
    entity: Annotated[str, Field(max_length=40)] = "orders"
    description: Note = ""
    sheet: Annotated[str, Field(max_length=120)] | None = "Sheet1"
    header_row: Annotated[int, Field(ge=1, le=1000)] = 1
    mapping: Annotated[dict[str, Annotated[str, Field(max_length=255)]], Field(max_length=200)] = Field(default_factory=dict)
    status: Short | None = None


class TemplateReviewIn(Schema):
    note: Note = ""


class TemplateOut(Schema):
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
