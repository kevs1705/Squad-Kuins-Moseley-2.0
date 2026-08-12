-- --------------------------------------------------------
-- Host:                         31.22.4.112
-- Versión del servidor:         10.11.14-MariaDB-cll-lve-log - MariaDB Server
-- SO del servidor:              Linux
-- HeidiSQL Versión:             12.1.0.6537
-- --------------------------------------------------------

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8 */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

-- Volcando estructura para tabla ciapeco1_Monseley.mensajes
CREATE TABLE IF NOT EXISTS `mensajes` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `nombre` varchar(100) NOT NULL,
  `email` varchar(100) NOT NULL,
  `telefono` varchar(50) DEFAULT NULL,
  `asunto` varchar(150) DEFAULT NULL,
  `mensaje` text NOT NULL,
  `fecha_envio` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- La exportación de datos fue deseleccionada.

-- Volcando estructura para tabla ciapeco1_Monseley.notificaciones
CREATE TABLE IF NOT EXISTS `notificaciones` (
  `id_notificacion` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `id_usuario` bigint(20) unsigned NOT NULL,
  `fecha_solicitada` date NOT NULL,
  `hora_inicio` time NOT NULL,
  `hora_fin` time NOT NULL,
  `motivo` text NOT NULL,
  `estado` int(11) NOT NULL DEFAULT 1,
  `observacion_admin` text DEFAULT NULL,
  `creado_en` timestamp NOT NULL DEFAULT current_timestamp(),
  `actualizado_en` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id_notificacion`),
  KEY `idx_notif_usuario` (`id_usuario`),
  CONSTRAINT `fk_notif_usuario` FOREIGN KEY (`id_usuario`) REFERENCES `usuarios` (`id_usuario`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- La exportación de datos fue deseleccionada.

-- Volcando estructura para tabla ciapeco1_Monseley.proyectos
CREATE TABLE IF NOT EXISTS `proyectos` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `titulo` varchar(255) NOT NULL,
  `categoria` varchar(50) NOT NULL,
  `descripcion` text DEFAULT NULL,
  `imagen` varchar(255) DEFAULT NULL,
  `estado` varchar(50) DEFAULT 'Entregado',
  `ubicacion` varchar(150) DEFAULT NULL,
  `superficie` varchar(50) DEFAULT NULL,
  `anio` int(11) DEFAULT NULL,
  `fecha_creacion` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- La exportación de datos fue deseleccionada.

-- Volcando estructura para tabla ciapeco1_Monseley.reportes
CREATE TABLE IF NOT EXISTS `reportes` (
  `id_reporte` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `id_usuario` bigint(20) unsigned NOT NULL,
  `fecha` date NOT NULL,
  `hora_acumulada` time DEFAULT NULL,
  `hora_inicio` time DEFAULT NULL,
  `hora_fin` time DEFAULT NULL,
  `tarea` text DEFAULT NULL,
  `comprobante` varchar(255) DEFAULT NULL,
  `observacion` text DEFAULT NULL,
  `creado_en` timestamp NOT NULL DEFAULT current_timestamp(),
  `actualizado_en` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id_reporte`),
  KEY `idx_reportes_usuario` (`id_usuario`),
  KEY `idx_reportes_fecha` (`fecha`),
  CONSTRAINT `fk_reportes_usuario` FOREIGN KEY (`id_usuario`) REFERENCES `usuarios` (`id_usuario`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=749 DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- La exportación de datos fue deseleccionada.

-- Volcando estructura para tabla ciapeco1_Monseley.usuarios
CREATE TABLE IF NOT EXISTS `usuarios` (
  `id_usuario` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `nombre` varchar(100) NOT NULL,
  `CI` varchar(32) NOT NULL,
  `universidad` varchar(120) NOT NULL,
  `carrera` varchar(120) NOT NULL,
  `celular` varchar(20) DEFAULT NULL,
  `estado` int(11) NOT NULL DEFAULT 0,
  `contrasena` varchar(255) NOT NULL,
  `rol` int(11) NOT NULL DEFAULT 0,
  `creado_en` timestamp NULL DEFAULT current_timestamp(),
  `actualizado_en` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id_usuario`),
  UNIQUE KEY `uk_usuarios_ci` (`CI`),
  KEY `idx_nombre_6c65c5` (`nombre`)
) ENGINE=InnoDB AUTO_INCREMENT=17 DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- La exportación de datos fue deseleccionada.

/*!40103 SET TIME_ZONE=IFNULL(@OLD_TIME_ZONE, 'system') */;
/*!40101 SET SQL_MODE=IFNULL(@OLD_SQL_MODE, '') */;
/*!40014 SET FOREIGN_KEY_CHECKS=IFNULL(@OLD_FOREIGN_KEY_CHECKS, 1) */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40111 SET SQL_NOTES=IFNULL(@OLD_SQL_NOTES, 1) */;
