/**
 * Phase 4 rename: projectService is the real module; observatoryService
 * is a thin re-export so every existing require — and every
 * /api/app/observatory route mounted over it — keeps working.
 */
const observatoryService = require('@goobster/core/services/observatoryService');
const projectService = require('@goobster/core/services/projectService');

describe('projectService / observatoryService re-export', () => {
    test('both paths resolve to the same singleton and named exports', () => {
        expect(projectService).toBe(observatoryService);
        expect(projectService.ObservatoryService).toBe(observatoryService.ObservatoryService);
        expect(projectService.ObservatoryError).toBe(observatoryService.ObservatoryError);
        expect(projectService.PROJECTS_ROOT).toBe(observatoryService.PROJECTS_ROOT);
        expect(projectService.DASHBOARDS_ROOT).toBe(observatoryService.DASHBOARDS_ROOT);
        expect(projectService.WORKSHOP_SLUG).toBe('workshop');
    });

    test('the moved module still exposes the owner-only reader used by applet routes', () => {
        expect(typeof projectService.listProjects).toBe('function');
        expect(typeof projectService.listFiles).toBe('function');
        expect(typeof projectService.readWorkspaceFile).toBe('function');
        expect(typeof projectService.readWorkspaceText).toBe('function');
        expect(typeof projectService.getProjectDetail).toBe('function');
        expect(typeof projectService.run).toBe('function');
    });
});
