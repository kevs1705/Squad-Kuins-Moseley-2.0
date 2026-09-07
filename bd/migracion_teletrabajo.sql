-- ==========================================================
-- MIGRACIÓN PARA MÓDULO DE TELETRABAJO
-- ==========================================================

-- 1. Crear tabla de solicitudes de teletrabajo
CREATE TABLE IF NOT EXISTS `solicitudes_teletrabajo` (
    `id_solicitud` BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
    `id_usuario` BIGINT(20) UNSIGNED NOT NULL,
    `fecha_solicitada` DATE NOT NULL,
    `hora_inicio` TIME DEFAULT '08:00:00',
    `hora_fin` TIME DEFAULT '17:00:00',
    `motivo` TEXT NOT NULL,
    `direccion_remota` VARCHAR(255) DEFAULT 'Domicilio particular',
    `estado` TINYINT(4) NOT NULL DEFAULT 1 COMMENT '1=Pendiente, 2=Aprobado, 3=Rechazado',
    `observacion_admin` TEXT DEFAULT NULL,
    `creado_en` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `actualizado_en` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id_solicitud`),
    KEY `idx_teletrabajo_usuario` (`id_usuario`),
    KEY `idx_teletrabajo_fecha` (`fecha_solicitada`),
    CONSTRAINT `fk_teletrabajo_usuario` FOREIGN KEY (`id_usuario`) REFERENCES `usuarios` (`id_usuario`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 2. Crear tabla 1 a 1 satélite para telemetría, GPS y teletrabajo
CREATE TABLE IF NOT EXISTS `asistencias_geo` (
    `id_geo` BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
    `id_asistencia` BIGINT(20) UNSIGNED NOT NULL,
    `modalidad` VARCHAR(30) NOT NULL DEFAULT 'PRESENCIAL',
    `id_solicitud_teletrabajo` BIGINT(20) UNSIGNED DEFAULT NULL,
    `lat_entrada` DECIMAL(10, 8) DEFAULT NULL,
    `lng_entrada` DECIMAL(11, 8) DEFAULT NULL,
    `precision_entrada_m` FLOAT DEFAULT NULL,
    `lat_salida` DECIMAL(10, 8) DEFAULT NULL,
    `lng_salida` DECIMAL(11, 8) DEFAULT NULL,
    `precision_salida_m` FLOAT DEFAULT NULL,
    `creado_en` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `actualizado_en` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id_geo`),
    UNIQUE KEY `uk_asistencia_geo` (`id_asistencia`),
    CONSTRAINT `fk_geo_asistencia` FOREIGN KEY (`id_asistencia`) REFERENCES `asistencias` (`id_asistencia`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `fk_geo_solicitud` FOREIGN KEY (`id_solicitud_teletrabajo`) REFERENCES `solicitudes_teletrabajo` (`id_solicitud`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;