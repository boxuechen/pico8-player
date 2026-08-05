pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
-- project-owned phase 1f conformance cart
x=4
updates30=0
updates60=0

function _update()
 updates30+=1
end

function _update60()
 updates60+=1
 if btn(0) then x-=1 end
end

function _draw()
 cls(2)
 pset(x,8,7)
 pset(updates60,16,10)
 pset(updates30,24,8)
end
