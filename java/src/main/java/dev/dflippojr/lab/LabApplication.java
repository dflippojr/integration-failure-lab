package dev.dflippojr.lab;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/**
 * Executed (v2) version of the integration failure lab: a real producer, delivery queue, and HTTP
 * claim-status service run the same scenarios as the browser simulation and export their traces.
 */
@SpringBootApplication
@ConfigurationPropertiesScan
public class LabApplication {

    public static void main(String[] args) {
        SpringApplication.run(LabApplication.class, args);
    }
}
