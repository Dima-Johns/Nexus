from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# Yakunlangan holatlar: haydovchi ro‘yxatidan chiqadi, Yakunlangan bo‘limiga o‘tadi
DONE_STATUSES = ("delivered", "returned")


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    code: Mapped[str] = mapped_column(String(32), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    address: Mapped[str] = mapped_column(String(300), default="")
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    users: Mapped[list["User"]] = relationship(back_populates="org")


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Login tashkilot ichida unikal (ux_users_org_username, migrate.py)
    username: Mapped[str] = mapped_column(String(80), index=True)
    password_hash: Mapped[str] = mapped_column(String(128))
    full_name: Mapped[str] = mapped_column(String(160))
    role: Mapped[str] = mapped_column(String(32), default="dispatcher")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    org_id: Mapped[int | None] = mapped_column(ForeignKey("organizations.id"), nullable=True, index=True)
    idle_timeout_minutes: Mapped[int] = mapped_column(Integer, default=30)
    permissions_json: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    org: Mapped[Organization | None] = relationship(back_populates="users")


class SessionToken(Base):
    __tablename__ = "session_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    driver_id: Mapped[int | None] = mapped_column(ForeignKey("drivers.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Client(Base):
    __tablename__ = "clients"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(ForeignKey("organizations.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    phone: Mapped[str] = mapped_column(String(40), default="")
    company: Mapped[str] = mapped_column(String(255), default="")
    address: Mapped[str] = mapped_column(String(500), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    orders: Mapped[list["Order"]] = relationship(back_populates="client")


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(ForeignKey("organizations.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(160))
    code: Mapped[str] = mapped_column(String(2), default="", index=True)
    code_locked: Mapped[bool] = mapped_column(Boolean, default=False)
    phone: Mapped[str] = mapped_column(String(40), default="")
    region: Mapped[str] = mapped_column(String(120), default="")
    commission_pct: Mapped[float] = mapped_column(Float, default=5.0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    drivers: Mapped[list["Driver"]] = relationship(back_populates="agent")


class Driver(Base):
    __tablename__ = "drivers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(ForeignKey("organizations.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(160))
    phone: Mapped[str] = mapped_column(String(40), default="")
    vehicle_plate: Mapped[str] = mapped_column(String(32), default="")
    vehicle_type: Mapped[str] = mapped_column(String(64), default="furgon")
    status: Mapped[str] = mapped_column(String(32), default="idle")
    lat: Mapped[float] = mapped_column(Float, default=41.3111)
    lng: Mapped[float] = mapped_column(Float, default=69.2797)
    heading: Mapped[float] = mapped_column(Float, default=0.0)
    agent_id: Mapped[int | None] = mapped_column(ForeignKey("agents.id"), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    username: Mapped[str] = mapped_column(String(80), default="", index=True)
    password_hash: Mapped[str] = mapped_column(String(128), default="")
    qr_token: Mapped[str] = mapped_column(String(64), default="", index=True)
    gps_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    gps_accuracy: Mapped[float] = mapped_column(Float, default=0.0)
    seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    gps_address: Mapped[str] = mapped_column(String(500), default="")
    geo_lat: Mapped[float] = mapped_column(Float, default=0.0)
    geo_lng: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    agent: Mapped[Agent | None] = relationship(back_populates="drivers")
    orders: Mapped[list["Order"]] = relationship(back_populates="driver")
    gps_pings: Mapped[list["GpsPing"]] = relationship(back_populates="driver")


class Warehouse(Base):
    __tablename__ = "warehouses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(ForeignKey("organizations.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(160))
    address: Mapped[str] = mapped_column(String(500), default="")
    lat: Mapped[float] = mapped_column(Float, default=41.3111)
    lng: Mapped[float] = mapped_column(Float, default=69.2797)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    orders: Mapped[list["Order"]] = relationship(back_populates="warehouse")


class DayPlan(Base):
    __tablename__ = "day_plans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(ForeignKey("organizations.id"), nullable=True, index=True)
    plan_date: Mapped[str] = mapped_column(String(10), index=True)
    name: Mapped[str] = mapped_column(String(160), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(ForeignKey("organizations.id"), nullable=True, index=True)
    code: Mapped[str] = mapped_column(String(80), index=True)
    client_id: Mapped[int | None] = mapped_column(ForeignKey("clients.id"), nullable=True)
    driver_id: Mapped[int | None] = mapped_column(ForeignKey("drivers.id"), nullable=True)
    warehouse_id: Mapped[int | None] = mapped_column(ForeignKey("warehouses.id"), nullable=True, index=True)
    pickup_address: Mapped[str] = mapped_column(String(500))
    dropoff_address: Mapped[str] = mapped_column(String(500))
    pickup_lat: Mapped[float] = mapped_column(Float, default=41.31)
    pickup_lng: Mapped[float] = mapped_column(Float, default=69.28)
    dropoff_lat: Mapped[float] = mapped_column(Float, default=41.32)
    dropoff_lng: Mapped[float] = mapped_column(Float, default=69.25)
    cargo: Mapped[str] = mapped_column(String(255), default="")
    weight_kg: Mapped[float] = mapped_column(Float, default=0)
    amount: Mapped[float] = mapped_column(Float, default=0)
    route_code: Mapped[str] = mapped_column(String(80), default="")
    sales_rep: Mapped[str] = mapped_column(String(160), default="")
    agent_code: Mapped[str] = mapped_column(String(2), default="")
    delivery_date: Mapped[str] = mapped_column(String(40), default="")
    window_start: Mapped[str] = mapped_column(String(8), default="")
    window_end: Mapped[str] = mapped_column(String(8), default="")
    extra_json: Mapped[str] = mapped_column(Text, default="{}")
    stop_no: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(32), default="new")
    eta_minutes: Mapped[int] = mapped_column(Integer, default=30)
    proof_reason: Mapped[str] = mapped_column(String(40), default="")
    proof_photo: Mapped[str] = mapped_column(String(300), default="")
    proof_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    client: Mapped[Client | None] = relationship(back_populates="orders")
    driver: Mapped[Driver | None] = relationship(back_populates="orders")
    warehouse: Mapped["Warehouse | None"] = relationship(back_populates="orders")


class ImportTemplate(Base):
    __tablename__ = "import_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(ForeignKey("organizations.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(160))
    entity: Mapped[str] = mapped_column(String(40), default="orders")
    description: Mapped[str] = mapped_column(Text, default="")
    mapping_json: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="pending")
    submitted_by: Mapped[str] = mapped_column(String(80), default="dispatcher")
    reviewed_by: Mapped[str | None] = mapped_column(String(80), nullable=True)
    review_note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class GpsPing(Base):
    __tablename__ = "gps_pings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    driver_id: Mapped[int] = mapped_column(ForeignKey("drivers.id"), index=True)
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    heading: Mapped[float] = mapped_column(Float, default=0.0)
    accuracy: Mapped[float] = mapped_column(Float, default=0.0)
    speed: Mapped[float] = mapped_column(Float, default=0.0)
    offline_cached: Mapped[bool] = mapped_column(Boolean, default=False)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    driver: Mapped[Driver] = relationship(back_populates="gps_pings")
