use tauri::{PhysicalPosition, PhysicalRect, PhysicalSize};

#[derive(Debug, PartialEq)]
pub(crate) struct InitialGeometry {
    pub position: PhysicalPosition<i32>,
    pub size: PhysicalSize<u32>,
    pub minimum: PhysicalSize<u32>,
}

/// Ordinary, undecorated windows start at 1200×780 logical pixels. Some Linux
/// compositors report an empty work area before mapping the first window.
pub(crate) fn initial_geometry(
    work_area: PhysicalRect<i32, u32>,
    monitor: PhysicalRect<i32, u32>,
    scale: f64,
) -> Option<InitialGeometry> {
    let area = if work_area.size.width > 0 && work_area.size.height > 0 {
        work_area
    } else {
        monitor
    };
    if area.size.width == 0 || area.size.height == 0 || !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let pixels = |logical: f64| (logical * scale).round().clamp(1.0, f64::from(u32::MAX)) as u32;
    let size = PhysicalSize::new(
        pixels(1200.0).min(area.size.width),
        pixels(780.0).min(area.size.height),
    );
    let centered = |origin: i32, available: u32, desired: u32| {
        (i64::from(origin) + i64::from(available - desired) / 2)
            .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
    };
    Some(InitialGeometry {
        position: PhysicalPosition::new(
            centered(area.position.x, area.size.width, size.width),
            centered(area.position.y, area.size.height, size.height),
        ),
        size,
        minimum: PhysicalSize::new(
            pixels(640.0).min(size.width),
            pixels(480.0).min(size.height),
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(x: i32, y: i32, width: u32, height: u32) -> PhysicalRect<i32, u32> {
        PhysicalRect {
            position: PhysicalPosition::new(x, y),
            size: PhysicalSize::new(width, height),
        }
    }

    #[test]
    fn normal_startup_uses_configured_size_and_centers_in_work_area() {
        let geometry =
            initial_geometry(area(0, 30, 1920, 1050), area(0, 0, 1920, 1080), 1.0).unwrap();
        assert_eq!(geometry.size, PhysicalSize::new(1200, 780));
        assert_eq!(geometry.position, PhysicalPosition::new(360, 165));
        assert_eq!(geometry.minimum, PhysicalSize::new(640, 480));
    }

    #[test]
    fn hidpi_and_fractional_scales_keep_the_logical_size() {
        for scale in [1.25, 1.5, 2.0] {
            let geometry = initial_geometry(
                area(-3840, 0, 3840, 2160),
                area(-3840, 0, 3840, 2160),
                scale,
            )
            .unwrap();
            assert_eq!(geometry.size.width, (1200.0 * scale) as u32);
            assert_eq!(geometry.size.height, (780.0 * scale) as u32);
            assert!(geometry.position.x < 0);
        }
    }

    #[test]
    fn empty_work_area_falls_back_to_monitor_instead_of_one_pixel() {
        let geometry = initial_geometry(area(0, 0, 0, 0), area(0, 0, 1440, 900), 1.0).unwrap();
        assert_eq!(geometry.size, PhysicalSize::new(1200, 780));
        assert_eq!(geometry.position, PhysicalPosition::new(120, 60));
    }

    #[test]
    fn small_screen_remains_usable_without_minimum_overflow() {
        let geometry =
            initial_geometry(area(-500, 20, 500, 400), area(-500, 0, 500, 420), 2.0).unwrap();
        assert_eq!(geometry.size, PhysicalSize::new(500, 400));
        assert_eq!(geometry.minimum, geometry.size);
        assert_eq!(geometry.position, PhysicalPosition::new(-500, 20));
    }

    #[test]
    fn invalid_monitor_data_preserves_builder_defaults() {
        assert!(initial_geometry(area(0, 0, 0, 0), area(0, 0, 0, 900), 1.0).is_none());
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(
                initial_geometry(area(0, 0, 1440, 900), area(0, 0, 1440, 900), scale).is_none()
            );
        }
    }
}
