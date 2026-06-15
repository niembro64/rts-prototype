#[inline]
pub(crate) fn drag_coefficient_from_friction_per_60hz_frame(
    friction_per_60hz_frame: f64,
    scale: f64,
) -> f64 {
    if !friction_per_60hz_frame.is_finite()
        || friction_per_60hz_frame <= 0.0
        || !scale.is_finite()
        || scale <= 0.0
    {
        return 0.0;
    }
    if friction_per_60hz_frame >= 1.0 {
        return f64::INFINITY;
    }
    let drag_rate_at_reference_mass = -(1.0 - friction_per_60hz_frame).ln() * 60.0 * scale;
    drag_rate_at_reference_mass * crate::AIR_DRAG_REFERENCE_MASS
}

#[inline]
pub(crate) fn drag_rate_from_coefficient(drag_coefficient: f64, inv_mass: f64) -> f64 {
    if !drag_coefficient.is_finite()
        || drag_coefficient <= 0.0
        || !inv_mass.is_finite()
        || inv_mass <= 0.0
    {
        return 0.0;
    }
    drag_coefficient * inv_mass
}

#[inline]
pub(crate) fn drag_rate_from_friction_per_60hz_frame(
    friction_per_60hz_frame: f64,
    scale: f64,
    mass: f64,
) -> f64 {
    if !mass.is_finite() || mass <= 1e-6 {
        return 0.0;
    }
    drag_rate_from_coefficient(
        drag_coefficient_from_friction_per_60hz_frame(friction_per_60hz_frame, scale),
        1.0 / mass,
    )
}

#[inline]
pub(crate) fn integrate_linear_drag_axis(
    pos: &mut f64,
    vel: &mut f64,
    accel: f64,
    dt_sec: f64,
    drag_rate: f64,
    wind_velocity: f64,
) {
    if !dt_sec.is_finite() || dt_sec <= 0.0 {
        return;
    }
    if !drag_rate.is_finite() || drag_rate <= 1e-9 {
        *pos += *vel * dt_sec + 0.5 * accel * dt_sec * dt_sec;
        *vel += accel * dt_sec;
        return;
    }
    let damp = (-drag_rate * dt_sec).exp();
    let retention_loss = 1.0 - damp;
    if !damp.is_finite() || !retention_loss.is_finite() {
        return;
    }
    let terminal = wind_velocity + accel / drag_rate;
    *pos += (*vel - terminal) * retention_loss / drag_rate + terminal * dt_sec;
    *vel = *vel * damp + terminal * retention_loss;
}
