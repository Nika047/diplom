using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace radar.forecast.data.Migrations
{
    /// <inheritdoc />
    public partial class Scenarios : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "ScenarioName",
                table: "DbRun",
                type: "TEXT",
                maxLength: 200,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "TrackId",
                table: "DbRun",
                type: "TEXT",
                maxLength: 255,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "TrackRun",
                table: "DbRun",
                type: "TEXT",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "Edited",
                table: "DbModel",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "Run",
                table: "DbModel",
                type: "TEXT",
                maxLength: 64,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "DbScenario",
                columns: table => new
                {
                    OID = table.Column<Guid>(type: "TEXT", nullable: false),
                    Name = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    Note = table.Column<string>(type: "TEXT", maxLength: 4000, nullable: true),
                    FlightSource = table.Column<string>(type: "TEXT", maxLength: 16, nullable: false),
                    LogName = table.Column<string>(type: "TEXT", maxLength: 255, nullable: true),
                    SourceFile = table.Column<Guid>(type: "TEXT", nullable: true),
                    TrackRun = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                    TrackId = table.Column<string>(type: "TEXT", maxLength: 255, nullable: true),
                    Piece = table.Column<int>(type: "INTEGER", nullable: true),
                    Mode = table.Column<string>(type: "TEXT", maxLength: 16, nullable: false),
                    Speed = table.Column<double>(type: "REAL", nullable: true),
                    StartScan = table.Column<int>(type: "INTEGER", nullable: true),
                    Autoplay = table.Column<bool>(type: "INTEGER", nullable: false),
                    Pd = table.Column<double>(type: "REAL", nullable: true),
                    RadarLat = table.Column<double>(type: "REAL", nullable: true),
                    RadarLon = table.Column<double>(type: "REAL", nullable: true),
                    RadarAlt = table.Column<double>(type: "REAL", nullable: true),
                    Basemap = table.Column<string>(type: "TEXT", maxLength: 16, nullable: true),
                    Horizons = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                    Layers = table.Column<string>(type: "TEXT", maxLength: 128, nullable: true),
                    Focus = table.Column<bool>(type: "INTEGER", nullable: true),
                    Created = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DbScenario", x => x.OID);
                    table.ForeignKey(
                        name: "FK_DbScenario_DbSourceFile_SourceFile",
                        column: x => x.SourceFile,
                        principalTable: "DbSourceFile",
                        principalColumn: "OID",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "DbScenarioModel",
                columns: table => new
                {
                    OID = table.Column<Guid>(type: "TEXT", nullable: false),
                    Scenario = table.Column<Guid>(type: "TEXT", nullable: true),
                    Model = table.Column<Guid>(type: "TEXT", nullable: true),
                    Position = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DbScenarioModel", x => x.OID);
                    table.ForeignKey(
                        name: "FK_DbScenarioModel_DbModel_Model",
                        column: x => x.Model,
                        principalTable: "DbModel",
                        principalColumn: "OID",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_DbScenarioModel_DbScenario_Scenario",
                        column: x => x.Scenario,
                        principalTable: "DbScenario",
                        principalColumn: "OID",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_DbScenario_Name",
                table: "DbScenario",
                column: "Name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_DbScenario_SourceFile",
                table: "DbScenario",
                column: "SourceFile");

            migrationBuilder.CreateIndex(
                name: "IX_DbScenarioModel_Model",
                table: "DbScenarioModel",
                column: "Model");

            migrationBuilder.CreateIndex(
                name: "IX_DbScenarioModel_Scenario",
                table: "DbScenarioModel",
                column: "Scenario");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "DbScenarioModel");

            migrationBuilder.DropTable(
                name: "DbScenario");

            migrationBuilder.DropColumn(
                name: "ScenarioName",
                table: "DbRun");

            migrationBuilder.DropColumn(
                name: "TrackId",
                table: "DbRun");

            migrationBuilder.DropColumn(
                name: "TrackRun",
                table: "DbRun");

            migrationBuilder.DropColumn(
                name: "Edited",
                table: "DbModel");

            migrationBuilder.DropColumn(
                name: "Run",
                table: "DbModel");
        }
    }
}
