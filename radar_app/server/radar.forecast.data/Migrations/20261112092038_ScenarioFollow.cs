using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace radar.forecast.data.Migrations
{
    /// <inheritdoc />
    public partial class ScenarioFollow : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "Follow",
                table: "DbScenario",
                type: "INTEGER",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Follow",
                table: "DbScenario");
        }
    }
}
