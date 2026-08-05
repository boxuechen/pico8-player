pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
-- project-owned phase 1f conformance cart
x=8
updates=0
presses=0

function _init()
 cls(0)
end

function _update()
 updates+=1
 if btn(1) then x+=1 end
 if btnp(4) then presses+=1 end
end

function _draw()
 cls(1)
 pset(x,8,7)
 pset(updates,16,8)
 pset(presses,24,9)
end
